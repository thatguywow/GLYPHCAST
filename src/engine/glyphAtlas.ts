export interface GlyphAtlas {
  texture: GPUTexture;
  /** Per-glyph 4x8 ink-coverage signature, flattened as vec4 rows (32 floats/glyph). */
  signatures: Float32Array;
  /** Mean ink coverage per glyph, ascending order == the luminance ramp order. */
  coverage: Float32Array;
  /** Ramp = coverage-sorted glyph indices, used by the fast (non-matching) path. */
  ramp: Uint32Array;
  glyphCount: number;
  tile: number;
}

/**
 * A wide, shape-diverse glyph set. With signature matching the renderer picks by
 * SHAPE, not just darkness, so diagonals/verticals/curves all earn their place.
 */
const CHARS = [
  ' ', '.', '`', "'", ',', ':', ';', '"', '^', '~', '-', '_', '=', '+', '<', '>',
  '(', ')', '[', ']', '{', '}', '|', '/', '\\', '!', 'i', 'l', 'I', 'j', 'r', 't',
  'f', 'v', 'x', 'z', 'c', 'n', 'u', 'o', 's', 'y', 'J', 'L', 'T', 'C', 'Y', '1',
  '7', '?', 'F', 'k', 'h', 'd', 'b', 'p', 'q', 'w', 'm', 'a', 'e', 'g', '3', '2',
  'V', 'X', 'Z', 'A', 'H', 'K', 'P', 'S', 'U', 'O', 'G', 'D', 'Q', 'R', 'N', 'E',
  'M', 'W', '&', '$', '0', '8', '#', '%', 'B', '@', '█',
];

// Signature grid per glyph. Taller than wide: glyphs differ far more vertically
// (ascenders, x-height, descenders) than horizontally, so vertical resolution buys
// the most matching accuracy per unit of compute.
const SIGW = 4;
const SIGH = 8;

/**
 * Rasterises every glyph into a single-row texture atlas and computes each
 * glyph's 4x4 ink-coverage signature (used for per-cell shape matching).
 */
export function buildGlyphAtlas(device: GPUDevice, tile = 32): GlyphAtlas {
  const n = CHARS.length;
  const w = tile * n;
  const h = tile;

  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.floor(tile * 0.95)}px "Consolas","DejaVu Sans Mono","Courier New",monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  CHARS.forEach((c, i) => ctx.fillText(c, i * tile + tile / 2, tile / 2 + 1));

  // Per-glyph SIG x SIG coverage signature, from the rasterised pixels.
  const px = ctx.getImageData(0, 0, w, h).data;
  const signatures = new Float32Array(n * SIGW * SIGH);
  const coverage = new Float32Array(n);
  const cellW = tile / SIGW;
  const cellH = tile / SIGH;

  for (let g = 0; g < n; g++) {
    let total = 0;
    for (let sy = 0; sy < SIGH; sy++) {
      for (let sx = 0; sx < SIGW; sx++) {
        let sum = 0;
        let count = 0;
        const x0 = Math.floor(g * tile + sx * cellW);
        const x1 = Math.floor(g * tile + (sx + 1) * cellW);
        const y0 = Math.floor(sy * cellH);
        const y1 = Math.floor((sy + 1) * cellH);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            sum += px[(y * w + x) * 4] / 255;
            count++;
          }
        }
        const v = count ? sum / count : 0;
        signatures[g * SIGW * SIGH + sy * SIGW + sx] = v;
        total += v;
      }
    }
    coverage[g] = total / (SIGW * SIGH);
  }

  // Ramp: glyph indices sorted by ink coverage (sparse -> dense).
  const ramp = new Uint32Array(
    Array.from({ length: n }, (_, i) => i).sort((a, b) => coverage[a] - coverage[b]),
  );

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

  return { texture, signatures, coverage, ramp, glyphCount: n, tile };
}
