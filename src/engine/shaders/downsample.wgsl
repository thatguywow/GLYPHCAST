// Pass 1: reduce the full-resolution video frame to a per-cell buffer.
// Each cell stores average RGB (rgb) and average luminance (a).

struct DU {
  gridW: u32,
  gridH: u32,
  _pad0: u32,
  _pad1: u32,
  videoW: u32,
  videoH: u32,
  _pad2: u32,
  _pad3: u32,
};

@group(0) @binding(0) var videoTex: texture_2d<f32>;
@group(0) @binding(1) var cellTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> u: DU;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= u.gridW || gid.y >= u.gridH) {
    return;
  }

  // Source-texel block covered by this cell.
  let bx = f32(u.videoW) / f32(u.gridW);
  let by = f32(u.videoH) / f32(u.gridH);
  let x0 = u32(f32(gid.x) * bx);
  let y0 = u32(f32(gid.y) * by);
  let x1 = min(u32(f32(gid.x + 1u) * bx), u.videoW);
  let y1 = min(u32(f32(gid.y + 1u) * by), u.videoH);

  // Cap the inner loop: sample at most ~7x7 texels per cell regardless of block size.
  let stepX = max(1u, (x1 - x0) / 7u);
  let stepY = max(1u, (y1 - y0) / 7u);

  var acc = vec3f(0.0);
  var n = 0.0;
  var yy = y0;
  loop {
    if (yy >= y1) { break; }
    var xx = x0;
    loop {
      if (xx >= x1) { break; }
      acc += textureLoad(videoTex, vec2u(xx, yy), 0).rgb;
      n += 1.0;
      xx += stepX;
    }
    yy += stepY;
  }

  let avg = select(vec3f(0.0), acc / n, n > 0.0);
  let lum = dot(avg, vec3f(0.299, 0.587, 0.114));
  textureStore(cellTex, vec2i(gid.xy), vec4f(avg, lum));
}
