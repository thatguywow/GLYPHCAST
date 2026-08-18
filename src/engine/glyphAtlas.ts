export interface GlyphAtlas {
  texture: GPUTexture;
  /** Total tiles in the atlas (ramp + edge glyphs). */
  glyphCount: number;
  /** Number of luminance-ramp glyphs; edge glyphs occupy indices [rampLen, glyphCount). */
  rampLen: number;
  tile: number;
}

// Sparse -> dense. Index 0 (space) = darkest/empty, last = brightest/solid.
const RAMP = ' .:-=+*#%@';
// Edge glyphs. Order MUST match the edge index mapping in ascii.wgsl:
//   0 = '|' (vertical), 1 = '/' , 2 = '-' (horizontal), 3 = '\'
const EDGES = ['|', '/', '-', '\\'];

/**
 * Rasterises every glyph into a single-row texture atlas (one tile per glyph).
 * The shader samples tile `i` at U in [i/glyphCount, (i+1)/glyphCount).
 */
export function buildGlyphAtlas(device: GPUDevice, tile = 32): GlyphAtlas {
  const chars = [...RAMP, ...EDGES];
  const w = tile * chars.length;
  const h = tile;

  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = `900 ${Math.floor(tile * 0.92)}px "Consolas","DejaVu Sans Mono","Courier New",monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  chars.forEach((c, i) => ctx.fillText(c, i * tile + tile / 2, tile / 2 + 1));

  const texture = device.createTexture({
    label: 'glyph-atlas',
    size: [w, h, 1],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: cv }, { texture }, [w, h]);

  return { texture, glyphCount: chars.length, rampLen: RAMP.length, tile };
}
