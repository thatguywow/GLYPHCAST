// Pass 2: render the cell buffer as glyphs (ASCII modes) or sample the video at
// sub-cell resolution (block modes), then apply brightness + gamma.

struct RU {
  gridW: u32,
  gridH: u32,
  glyphCount: u32,
  rampLen: u32,
  edgeThreshold: f32,
  edgeEnable: u32,
  mode: u32,
  gamma: f32,
  gain: f32,
  bgFloor: f32,
  tintR: f32,
  tintG: f32,
  tintB: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
};

@group(0) @binding(0) var cellTex: texture_2d<f32>;
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var atlasSamp: sampler;
@group(0) @binding(3) var<uniform> u: RU;
@group(0) @binding(4) var videoTex: texture_2d<f32>;
@group(0) @binding(5) var videoSamp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  let ndc = p[i];
  o.uv = vec2f((ndc.x + 1.0) * 0.5, (1.0 - ndc.y) * 0.5); // top-left origin
  return o;
}

fn lumAt(cx: i32, cy: i32) -> f32 {
  let gx = clamp(cx, 0, i32(u.gridW) - 1);
  let gy = clamp(cy, 0, i32(u.gridH) - 1);
  return textureLoad(cellTex, vec2i(gx, gy), 0).a;
}

const PI: f32 = 3.14159265;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let gridF = vec2f(f32(u.gridW), f32(u.gridH));
  let cellF = in.uv * gridF;
  let cell = vec2i(floor(cellF));
  let cc = clamp(cell, vec2i(0), vec2i(i32(u.gridW) - 1, i32(u.gridH) - 1));
  let localUV = fract(cellF);
  let center = textureLoad(cellTex, cc, 0);

  var outRGB: vec3f;

  if (u.mode >= 2u) {
    // Block modes: sample the real frame at sub-cell resolution, quantised to a
    // sub-grid so it keeps the blocky "cells" look but with true color detail.
    var sub = vec2f(1.0, 2.0);            // HalfBlock: 1 x 2
    if (u.mode == 3u) { sub = vec2f(2.0, 2.0); }  // QuarterBlock
    if (u.mode == 4u) { sub = vec2f(1.0, 1.0); }  // FullBlock mosaic
    let si = floor(localUV * sub);
    let sampUV = (vec2f(cell) + (si + vec2f(0.5)) / sub) / gridF;
    outRGB = textureSampleLevel(videoTex, videoSamp, clamp(sampUV, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  } else {
    // ASCII modes: choose a glyph, sample the atlas, tint by color or mono.
    var glyph: u32 = 0u;
    var isEdge = false;

    if (u.edgeEnable == 1u) {
      let tl = lumAt(cell.x - 1, cell.y - 1);
      let tc = lumAt(cell.x,     cell.y - 1);
      let tr = lumAt(cell.x + 1, cell.y - 1);
      let ml = lumAt(cell.x - 1, cell.y);
      let mr = lumAt(cell.x + 1, cell.y);
      let bl = lumAt(cell.x - 1, cell.y + 1);
      let bc = lumAt(cell.x,     cell.y + 1);
      let br = lumAt(cell.x + 1, cell.y + 1);

      let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
      let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
      let mag = length(vec2f(gx, gy));

      if (mag > u.edgeThreshold) {
        isEdge = true;
        var ang = atan2(gy, gx);
        if (ang < 0.0) { ang += PI; }
        let a = ang / PI;
        var e: u32;
        if (a < 0.125 || a >= 0.875) {
          e = 0u;  // '|'
        } else if (a < 0.375) {
          e = 3u;  // '\'
        } else if (a < 0.625) {
          e = 2u;  // '-'
        } else {
          e = 1u;  // '/'
        }
        glyph = u.rampLen + e;
      }
    }

    if (!isEdge) {
      let idx = u32(clamp(center.a, 0.0, 1.0) * f32(u.rampLen - 1u) + 0.5);
      glyph = min(idx, u.rampLen - 1u);
    }

    let au = (f32(glyph) + localUV.x) / f32(u.glyphCount);
    let cov = textureSampleLevel(atlasTex, atlasSamp, vec2f(au, localUV.y), 0.0).r;

    var fg: vec3f;
    if (u.mode == 1u) {
      fg = center.rgb;
    } else {
      fg = vec3f(u.tintR, u.tintG, u.tintB);
    }
    // Glyph over a dim tinted background instead of pure black gaps -> richer.
    outRGB = mix(fg * u.bgFloor, fg, cov);
  }

  // Brightness then gamma.
  outRGB = pow(clamp(outRGB * u.gain, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / max(u.gamma, 0.01)));
  return vec4f(outRGB, 1.0);
}
