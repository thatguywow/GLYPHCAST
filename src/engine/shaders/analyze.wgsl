// Pass 1: analyse each cell of the source frame.
//
// For every cell we build a 4x4 luminance signature, split the cell into "ink"
// and "paper" by its own midpoint, and derive a foreground + background colour.
// When matching is enabled we then pick the glyph whose ink pattern best fits the
// cell (sum of squared differences over the normalised signature) — this is what
// makes edges, diagonals and texture appear naturally, instead of mapping
// brightness onto an arbitrary ramp.

struct AU {
  gridW: u32,
  gridH: u32,
  videoW: u32,
  videoH: u32,
  glyphCount: u32,
  matchGlyphs: u32,
  rampLen: u32,
  _pad: u32,
};

@group(0) @binding(0) var videoTex: texture_2d<f32>;
@group(0) @binding(1) var fgTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var bgTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var glyphTex: texture_storage_2d<r32uint, write>;
@group(0) @binding(4) var<uniform> u: AU;
@group(0) @binding(5) var<storage, read> sig: array<vec4f>;   // 4 vec4 rows per glyph
@group(0) @binding(6) var<storage, read> ramp: array<u32>;    // coverage-sorted indices

const SIG: u32 = 4u;

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= u.gridW || gid.y >= u.gridH) {
    return;
  }

  // Source-texel block covered by this cell.
  let bx = f32(u.videoW) / f32(u.gridW);
  let by = f32(u.videoH) / f32(u.gridH);
  let x0 = f32(gid.x) * bx;
  let y0 = f32(gid.y) * by;

  // Sub-block accumulation: 4x4 signature of luminance + colour.
  var sLum: array<f32, 16>;
  var sCol: array<vec3f, 16>;

  let sw = bx / f32(SIG);
  let sh = by / f32(SIG);
  // Sample up to 3x3 source texels per sub-block (16 sub-blocks => <=144 taps).
  let stepsX = max(1u, min(3u, u32(sw)));
  let stepsY = max(1u, min(3u, u32(sh)));

  var lo = 1.0;
  var hi = 0.0;

  for (var sy: u32 = 0u; sy < SIG; sy++) {
    for (var sx: u32 = 0u; sx < SIG; sx++) {
      var acc = vec3f(0.0);
      var n = 0.0;
      for (var ty: u32 = 0u; ty < stepsY; ty++) {
        for (var tx: u32 = 0u; tx < stepsX; tx++) {
          let fx = x0 + sw * (f32(sx) + (f32(tx) + 0.5) / f32(stepsX));
          let fy = y0 + sh * (f32(sy) + (f32(ty) + 0.5) / f32(stepsY));
          let px = min(u32(fx), u.videoW - 1u);
          let py = min(u32(fy), u.videoH - 1u);
          acc += textureLoad(videoTex, vec2u(px, py), 0).rgb;
          n += 1.0;
        }
      }
      let c = acc / max(n, 1.0);
      let i = sy * SIG + sx;
      sCol[i] = c;
      let l = lum(c);
      sLum[i] = l;
      lo = min(lo, l);
      hi = max(hi, l);
    }
  }

  // Normalise the cell's own dynamic range so matching compares SHAPE, not level.
  let range = max(hi - lo, 1e-4);
  let mid = (hi + lo) * 0.5;

  var fg = vec3f(0.0);
  var bg = vec3f(0.0);
  var nf = 0.0;
  var nb = 0.0;
  for (var i: u32 = 0u; i < 16u; i++) {
    if (sLum[i] >= mid) {
      fg += sCol[i];
      nf += 1.0;
    } else {
      bg += sCol[i];
      nb += 1.0;
    }
  }
  // A flat cell has no meaningful split — collapse both to the mean.
  if (nf > 0.0) { fg = fg / nf; }
  if (nb > 0.0) { bg = bg / nb; }
  if (nf == 0.0) { fg = bg; }
  if (nb == 0.0) { bg = fg; }

  var best: u32 = 0u;

  if (u.matchGlyphs == 1u) {
    // Pick the glyph whose ink pattern minimises squared error against the cell.
    var bestErr = 1e9;
    for (var g: u32 = 0u; g < u.glyphCount; g++) {
      var err = 0.0;
      for (var r: u32 = 0u; r < SIG; r++) {
        let row = sig[g * SIG + r];
        let b = r * SIG;
        let d0 = row.x - (sLum[b + 0u] - lo) / range;
        let d1 = row.y - (sLum[b + 1u] - lo) / range;
        let d2 = row.z - (sLum[b + 2u] - lo) / range;
        let d3 = row.w - (sLum[b + 3u] - lo) / range;
        err += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
      }
      if (err < bestErr) {
        bestErr = err;
        best = g;
      }
    }
  } else {
    // Fast path: map mean luminance onto the coverage-sorted ramp.
    var mean = 0.0;
    for (var i: u32 = 0u; i < 16u; i++) { mean += sLum[i]; }
    mean = mean / 16.0;
    let idx = min(u32(clamp(mean, 0.0, 1.0) * f32(u.rampLen - 1u) + 0.5), u.rampLen - 1u);
    best = ramp[idx];
  }

  let p = vec2i(gid.xy);
  textureStore(fgTex, p, vec4f(fg, 1.0));
  textureStore(bgTex, p, vec4f(bg, 1.0));
  textureStore(glyphTex, p, vec4u(best, 0u, 0u, 1u));
}
