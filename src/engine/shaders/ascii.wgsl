// Pass 2: composite. ASCII modes draw the matched glyph with the cell's own
// foreground/background colours (two real colours per cell). Block modes sample
// the source at sub-cell resolution instead. Brightness/gamma applied last.

struct RU {
  gridW: u32,
  gridH: u32,
  glyphCount: u32,
  mode: u32,
  gain: f32,
  gamma: f32,
  tintR: f32,
  tintG: f32,
  tintB: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
};

@group(0) @binding(0) var fgTex: texture_2d<f32>;
@group(0) @binding(1) var bgTex: texture_2d<f32>;
@group(0) @binding(2) var glyphTex: texture_2d<u32>;
@group(0) @binding(3) var atlasTex: texture_2d<f32>;
@group(0) @binding(4) var atlasSamp: sampler;
@group(0) @binding(5) var<uniform> u: RU;
@group(0) @binding(6) var videoTex: texture_2d<f32>;
@group(0) @binding(7) var videoSamp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5); // top-left origin
  return o;
}

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let gridF = vec2f(f32(u.gridW), f32(u.gridH));
  let cellF = in.uv * gridF;
  let cell = vec2i(floor(cellF));
  let cc = clamp(cell, vec2i(0), vec2i(i32(u.gridW) - 1, i32(u.gridH) - 1));
  let localUV = fract(cellF);

  var outRGB: vec3f;

  if (u.mode >= 2u) {
    // Block modes: real colour at sub-cell resolution.
    var sub = vec2f(1.0, 2.0);                    // 2 = half    (1x2)
    if (u.mode == 3u) { sub = vec2f(2.0, 2.0); }  // 3 = quarter (2x2)
    if (u.mode == 4u) { sub = vec2f(1.0, 1.0); }  // 4 = full    (1x1 mosaic)
    if (u.mode == 5u) { sub = vec2f(2.0, 3.0); }  // 5 = sextant (2x3)
    if (u.mode == 6u) { sub = vec2f(2.0, 4.0); }  // 6 = octant  (2x4)
    if (u.mode == 7u) { sub = vec2f(4.0, 4.0); }  // 7 = hex     (4x4, max detail)
    let si = floor(localUV * sub);
    let sampUV = (vec2f(cell) + (si + vec2f(0.5)) / sub) / gridF;
    outRGB = textureSampleLevel(videoTex, videoSamp, clamp(sampUV, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  } else {
    let g = textureLoad(glyphTex, cc, 0).r;
    let au = (f32(g) + localUV.x) / f32(u.glyphCount);
    let cov = textureSampleLevel(atlasTex, atlasSamp, vec2f(au, localUV.y), 0.0).r;

    var fg = textureLoad(fgTex, cc, 0).rgb;
    var bg = textureLoad(bgTex, cc, 0).rgb;
    if (u.mode == 0u) {
      // Mono: keep the tonal split, drop the hue.
      let tint = vec3f(u.tintR, u.tintG, u.tintB);
      fg = tint * lum(fg);
      bg = tint * lum(bg);
    }
    outRGB = mix(bg, fg, cov);
  }

  outRGB = pow(clamp(outRGB * u.gain, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / max(u.gamma, 0.01)));
  return vec4f(outRGB, 1.0);
}
