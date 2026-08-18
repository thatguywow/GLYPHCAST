// Pass 1: analyse each cell of the source frame.
//
// For every cell we build a 4x8 luminance signature, cluster the cell's colours
// into an "ink" and a "paper" group, and pick the glyph whose ink pattern best
// fits the cell (sum of squared differences over the normalised signature).
// Matching by SHAPE rather than brightness is what makes edges, diagonals and
// texture appear naturally instead of smearing into a brightness ramp.

struct AU {
  gridW: u32,
  gridH: u32,
  videoW: u32,
  videoH: u32,
  glyphCount: u32,
  matchGlyphs: u32,
  rampLen: u32,
  useHysteresis: u32,
  hysteresis: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
};

@group(0) @binding(0) var videoTex: texture_2d<f32>;
@group(0) @binding(1) var fgTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var bgTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var glyphTex: texture_storage_2d<r32uint, write>;
@group(0) @binding(4) var<uniform> u: AU;
@group(0) @binding(5) var<storage, read> sig: array<vec4f>;   // SIGH vec4 rows per glyph
@group(0) @binding(6) var<storage, read> ramp: array<u32>;
@group(0) @binding(7) var prevGlyphTex: texture_2d<u32>;

const SIGW: u32 = 4u;
const SIGH: u32 = 8u;
const N: u32 = 32u;      // SIGW * SIGH
const ROWS: u32 = 8u;    // vec4 rows per glyph

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= u.gridW || gid.y >= u.gridH) {
    return;
  }

  let bx = f32(u.videoW) / f32(u.gridW);
  let by = f32(u.videoH) / f32(u.gridH);
  let x0 = f32(gid.x) * bx;
  let y0 = f32(gid.y) * by;

  var sLum: array<f32, 32>;
  var sCol: array<vec3f, 32>;

  let sw = bx / f32(SIGW);
  let sh = by / f32(SIGH);
  let stepsX = max(1u, min(3u, u32(sw)));
  let stepsY = max(1u, min(3u, u32(sh)));

  var lo = 1.0;
  var hi = 0.0;

  for (var sy: u32 = 0u; sy < SIGH; sy++) {
    for (var sx: u32 = 0u; sx < SIGW; sx++) {
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
      let i = sy * SIGW + sx;
      sCol[i] = c;
      let l = lum(c);
      sLum[i] = l;
      lo = min(lo, l);
      hi = max(hi, l);
    }
  }

  let range = max(hi - lo, 1e-4);

  // Two-means clustering on luminance: far better ink/paper separation than a
  // fixed midpoint, which mis-splits cells whose content is skewed bright or dark.
  var cFg = hi;
  var cBg = lo;
  for (var it: u32 = 0u; it < 3u; it++) {
    var sumF = 0.0; var nF = 0.0;
    var sumB = 0.0; var nB = 0.0;
    for (var i: u32 = 0u; i < N; i++) {
      if (abs(sLum[i] - cFg) <= abs(sLum[i] - cBg)) {
        sumF += sLum[i]; nF += 1.0;
      } else {
        sumB += sLum[i]; nB += 1.0;
      }
    }
    if (nF > 0.0) { cFg = sumF / nF; }
    if (nB > 0.0) { cBg = sumB / nB; }
  }

  // Final assignment -> average colour of each cluster.
  var fg = vec3f(0.0);
  var bg = vec3f(0.0);
  var nf = 0.0;
  var nb = 0.0;
  for (var i: u32 = 0u; i < N; i++) {
    if (abs(sLum[i] - cFg) <= abs(sLum[i] - cBg)) {
      fg += sCol[i]; nf += 1.0;
    } else {
      bg += sCol[i]; nb += 1.0;
    }
  }
  if (nf > 0.0) { fg = fg / nf; }
  if (nb > 0.0) { bg = bg / nb; }
  if (nf == 0.0) { fg = bg; }
  if (nb == 0.0) { bg = fg; }

  let p = vec2i(gid.xy);
  var best: u32 = 0u;

  if (u.matchGlyphs == 1u) {
    // Temporal hysteresis: a cell whose content barely changed can still flip to a
    // different glyph when two candidates score nearly equal, which reads as
    // shimmer in motion. Track the previous frame's glyph error in the same loop
    // (free) and keep it unless a challenger is clearly better.
    let prev = textureLoad(prevGlyphTex, p, 0).r;
    var errPrev = 1e9;

    var bestErr = 1e9;
    for (var g: u32 = 0u; g < u.glyphCount; g++) {
      var err = 0.0;
      for (var r: u32 = 0u; r < ROWS; r++) {
        let row = sig[g * ROWS + r];
        let b = r * SIGW;
        let d0 = row.x - (sLum[b + 0u] - lo) / range;
        let d1 = row.y - (sLum[b + 1u] - lo) / range;
        let d2 = row.z - (sLum[b + 2u] - lo) / range;
        let d3 = row.w - (sLum[b + 3u] - lo) / range;
        err += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
      }
      if (g == prev) {
        errPrev = err;
      }
      if (err < bestErr) {
        bestErr = err;
        best = g;
      }
    }

    if (u.useHysteresis == 1u && prev < u.glyphCount && errPrev <= bestErr * (1.0 + u.hysteresis)) {
      best = prev;
    }
  } else {
    var mean = 0.0;
    for (var i: u32 = 0u; i < N; i++) { mean += sLum[i]; }
    mean = mean / f32(N);
    let idx = min(u32(clamp(mean, 0.0, 1.0) * f32(u.rampLen - 1u) + 0.5), u.rampLen - 1u);
    best = ramp[idx];
  }

  textureStore(fgTex, p, vec4f(fg, 1.0));
  textureStore(bgTex, p, vec4f(bg, 1.0));
  textureStore(glyphTex, p, vec4u(best, 0u, 0u, 1u));
}
