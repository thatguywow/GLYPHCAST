// Pass 2: render the cell buffer as glyphs.
// Per output pixel: locate its cell, choose a glyph (edge-aware Sobel, else
// luminance ramp), sample the glyph atlas, tint by the cell's original color.

struct RU {
  gridW: u32,
  gridH: u32,
  glyphCount: u32,
  rampLen: u32,
  edgeThreshold: f32,
  edgeEnable: u32,
  colorMode: u32,
  _pad0: u32,
  tintR: f32,
  tintG: f32,
  tintB: f32,
  _pad1: f32,
};

@group(0) @binding(0) var cellTex: texture_2d<f32>;
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var atlasSamp: sampler;
@group(0) @binding(3) var<uniform> u: RU;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  // Fullscreen triangle.
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
  let clampedCell = clamp(cell, vec2i(0), vec2i(i32(u.gridW) - 1, i32(u.gridH) - 1));
  let localUV = fract(cellF);

  let center = textureLoad(cellTex, clampedCell, 0);
  let lum = center.a;

  var glyph: u32 = 0u;
  var isEdge = false;

  if (u.edgeEnable == 1u) {
    // Sobel over the 3x3 neighbourhood of cell luminance.
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
      var ang = atan2(gy, gx);          // gradient direction, -PI..PI
      if (ang < 0.0) { ang += PI; }     // edges are symmetric -> fold to 0..PI
      let a = ang / PI;                 // 0..1

      // Gradient direction -> perpendicular edge glyph.
      var e: u32;
      if (a < 0.125 || a >= 0.875) {
        e = 0u;                         // gradient horizontal -> vertical edge '|'
      } else if (a < 0.375) {
        e = 3u;                         // '\'
      } else if (a < 0.625) {
        e = 2u;                         // gradient vertical -> horizontal edge '-'
      } else {
        e = 1u;                         // '/'
      }
      glyph = u.rampLen + e;
    }
  }

  if (!isEdge) {
    let idx = u32(clamp(lum, 0.0, 1.0) * f32(u.rampLen - 1u) + 0.5);
    glyph = min(idx, u.rampLen - 1u);
  }

  // Sample the chosen glyph tile.
  let au = (f32(glyph) + localUV.x) / f32(u.glyphCount);
  let cov = textureSample(atlasTex, atlasSamp, vec2f(au, localUV.y)).r;

  var rgb: vec3f;
  if (u.colorMode == 1u) {
    rgb = center.rgb * cov;
  } else {
    rgb = vec3f(u.tintR, u.tintG, u.tintB) * cov;
  }
  return vec4f(rgb, 1.0);
}
