// Headless quality + performance harness. Renders every config across every test
// pattern offscreen, reads the pixels back, and scores them against a reference.
// No display or requestAnimationFrame needed.
//
//   window.__BENCH_DONE__  -> true when finished
//   window.__BENCH__       -> [{ pattern, config, metrics }]
//   window.__PERF__        -> [{ config, cols, msPerFrame, fps }]
//   window.gc.capture(pattern, configIndex) -> Promise<jpeg data URL>

import { initGPU } from '../engine/gpu';
import { buildGlyphAtlas } from '../engine/glyphAtlas';
import { Renderer } from '../engine/renderer';
import { DEFAULT_PARAMS, Mode, type RenderParams } from '../types';
import { computeMetrics, type Metrics } from './metrics';
import { ALL_PATTERNS, makePattern, type PatternName } from './patterns';

const COLS = 200;
const CELL = 6;

const base = (p: Partial<RenderParams>): RenderParams => ({
  ...DEFAULT_PARAMS,
  cols: COLS,
  cellPx: CELL,
  ...p,
});

const CONFIGS: { label: string; params: RenderParams }[] = [
  { label: 'ASCII color RAMP', params: base({ mode: Mode.AsciiColor, matchGlyphs: false }) },
  { label: 'ASCII color MATCH', params: base({ mode: Mode.AsciiColor, matchGlyphs: true }) },
  { label: 'ASCII mono MATCH', params: base({ mode: Mode.AsciiMono, matchGlyphs: true }) },
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
const cache: Partial<Record<PatternName, HTMLCanvasElement>> = {};
// Sources are rendered well above output resolution so the reference is produced
// by DOWNscaling (sharp) rather than upscaling (blurry). A blurry reference is
// insensitive to fine detail and would hide real quality changes.
const pattern = (n: PatternName) => (cache[n] ??= makePattern(n, 1920, 1080));

function referenceRGBA(src: HTMLCanvasElement, w: number, h: number): Uint8ClampedArray {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * True GPU throughput: submits the real render path repeatedly and waits for the
 * queue to drain. Excludes readback (which is a harness cost, not a playback one).
 */
async function perf(label: string, params: RenderParams, iterations = 60) {
  renderer.setParams(params);
  const pat = pattern('scene');
  renderer.renderOffscreen(pat, pat.width, pat.height);
  await renderer.deviceIdle();

  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) renderer.renderOffscreen(pat, pat.width, pat.height);
  await renderer.deviceIdle();
  const ms = (performance.now() - t0) / iterations;

  const [w, h] = renderer.outputSize;
  return {
    config: label,
    cols: params.cols,
    out: `${w}x${h}`,
    msPerFrame: +ms.toFixed(3),
    fps: +(1000 / ms).toFixed(0),
  };
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

  // Throughput: matching cost at increasing grid density.
  const perfRows = [];
  perfRows.push(await perf('MATCH 200c', base({ mode: Mode.AsciiColor, matchGlyphs: true })));
  perfRows.push(await perf('MATCH 320c', base({ mode: Mode.AsciiColor, matchGlyphs: true, cols: 320 })));
  perfRows.push(await perf('RAMP 320c', base({ mode: Mode.AsciiColor, matchGlyphs: false, cols: 320 })));
  perfRows.push(await perf('Quarter 320c', base({ mode: Mode.QuarterBlock, cols: 320 })));
  (window as any).__PERF__ = perfRows;
  document.getElementById('perf')!.textContent = JSON.stringify(perfRows, null, 1);

  (window as any).__BENCH_DONE__ = true;
}

function paint(rows: Row[]) {
  const head = ['pattern', 'config', 'PSNR dB', 'SSIM', 'edgePres', 'luma ref→out', 'contrast ref→out'];
  let html = '<table><thead><tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of rows) {
    const m = r.metrics;
    html +=
      `<tr><td>${r.pattern}</td><td>${r.config}</td><td>${m.psnr}</td><td>${m.ssim}</td>` +
      `<td>${m.edgePreservation}</td><td>${m.lumaMeanRef}→${m.lumaMeanOut}</td>` +
      `<td>${m.lumaContrastRef}→${m.lumaContrastOut}</td></tr>`;
  }
  document.getElementById('out')!.innerHTML = html + '</tbody></table>';
}

(window as any).gc = {
  configs: CONFIGS.map((c) => c.label),
  patterns: ALL_PATTERNS,
  async capture(name: PatternName, configIndex: number, maxW = 600): Promise<string> {
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
    const small = document.createElement('canvas');
    small.width = Math.round(width * scale);
    small.height = Math.round(height * scale);
    small.getContext('2d')!.drawImage(full, 0, 0, small.width, small.height);
    return small.toDataURL('image/jpeg', 0.82);
  },
};

run().catch((e) => {
  document.getElementById('out')!.textContent = 'ERROR: ' + (e as Error).message;
  console.error(e);
});
