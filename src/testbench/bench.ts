// Headless quality harness. Renders every mode across every test pattern into an
// offscreen texture, reads the pixels back, and computes objective metrics vs a
// reference (the source resampled to the same output resolution). No display or
// requestAnimationFrame required — runs fully from `run()` on load.
//
// After load:
//   window.__BENCH_DONE__  -> true when finished
//   window.__BENCH__       -> array of { pattern, config, metrics }
//   window.gc.capturePNG(pattern, configIndex) -> Promise<dataURL>  (for eyeballing)

import { initGPU } from '../engine/gpu';
import { buildGlyphAtlas } from '../engine/glyphAtlas';
import { Renderer } from '../engine/renderer';
import { DEFAULT_PARAMS, Mode, type RenderParams } from '../types';
import { computeMetrics, type Metrics } from './metrics';
import { ALL_PATTERNS, makePattern, type PatternName } from './patterns';

// Fixed grid across the sweep so output size (and thus the reference) is constant.
const COLS = 200;
const CELL = 6;

const base = (p: Partial<RenderParams>): RenderParams => ({
  ...DEFAULT_PARAMS,
  cols: COLS,
  cellPx: CELL,
  ...p,
});

const CONFIGS: { label: string; params: RenderParams }[] = [
  { label: 'ASCII mono +edge', params: base({ mode: Mode.AsciiMono, edgeEnable: true }) },
  { label: 'ASCII color +edge', params: base({ mode: Mode.AsciiColor, edgeEnable: true }) },
  { label: 'ASCII color -edge', params: base({ mode: Mode.AsciiColor, edgeEnable: false }) },
  { label: 'Half-block', params: base({ mode: Mode.HalfBlock }) },
  { label: 'Quarter-block', params: base({ mode: Mode.QuarterBlock }) },
  { label: 'Full-block', params: base({ mode: Mode.FullBlock }) },
];

interface Row {
  pattern: PatternName;
  config: string;
  metrics: Metrics;
}

let renderer!: Renderer;
const patternCache: Partial<Record<PatternName, HTMLCanvasElement>> = {};

function pattern(name: PatternName): HTMLCanvasElement {
  return (patternCache[name] ??= makePattern(name));
}

function referenceRGBA(src: HTMLCanvasElement, w: number, h: number): Uint8ClampedArray {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

async function run() {
  const canvas = document.getElementById('gpu') as HTMLCanvasElement;
  const gpu = await initGPU(canvas);
  const atlas = buildGlyphAtlas(gpu.device);
  renderer = new Renderer(gpu, atlas, CONFIGS[0].params);

  const rows: Row[] = [];
  for (const name of ALL_PATTERNS) {
    const pat = pattern(name);
    for (const c of CONFIGS) {
      renderer.setParams(c.params);
      const out = await renderer.readback(pat, pat.width, pat.height);
      const ref = referenceRGBA(pat, out.width, out.height);
      rows.push({ pattern: name, config: c.label, metrics: computeMetrics(ref, out.rgba, out.width, out.height) });
    }
  }

  paint(rows);
  (window as any).__BENCH__ = rows;
  (window as any).__BENCH_DONE__ = true;
}

function paint(rows: Row[]) {
  const head = ['pattern', 'config', 'PSNR dB', 'SSIM', 'edgePres', 'luma ref→out', 'contrast ref→out'];
  let html = '<table><thead><tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of rows) {
    const m = r.metrics;
    html +=
      `<tr><td>${r.pattern}</td><td>${r.config}</td>` +
      `<td>${m.psnr}</td><td>${m.ssim}</td><td>${m.edgePreservation}</td>` +
      `<td>${m.lumaMeanRef}→${m.lumaMeanOut}</td>` +
      `<td>${m.lumaContrastRef}→${m.lumaContrastOut}</td></tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('out')!.innerHTML = html;
  document.getElementById('json')!.textContent = JSON.stringify(rows);
}

(window as any).gc = {
  configs: CONFIGS.map((c) => c.label),
  patterns: ALL_PATTERNS,
  /** Returns a downscaled JPEG data URL of one render, small enough to shuttle out for inspection. */
  async capturePNG(name: PatternName, configIndex: number, maxW = 640): Promise<string> {
    renderer.setParams(CONFIGS[configIndex].params);
    const pat = pattern(name);
    const { width, height, rgba } = await renderer.readback(pat, pat.width, pat.height);
    const full = document.createElement('canvas');
    full.width = width;
    full.height = height;
    const fctx = full.getContext('2d')!;
    const img = fctx.createImageData(width, height);
    img.data.set(rgba);
    fctx.putImageData(img, 0, 0);
    const scale = Math.min(1, maxW / width);
    const ow = Math.round(width * scale);
    const oh = Math.round(height * scale);
    const small = document.createElement('canvas');
    small.width = ow;
    small.height = oh;
    small.getContext('2d')!.drawImage(full, 0, 0, ow, oh);
    return small.toDataURL('image/jpeg', 0.85);
  },
};

run().catch((e) => {
  document.getElementById('out')!.textContent = 'ERROR: ' + (e as Error).message;
  console.error(e);
});
