// End-to-end compiler check: compiles a real MP4 to .glyph, then decodes every
// frame back. Decoding the whole delta chain is the important part — a wrong
// offset or payload length only shows up part way through a file, not on frame 0.

import { initGPU } from '../engine/gpu';
import { buildGlyphAtlas } from '../engine/glyphAtlas';
import { Renderer } from '../engine/renderer';
import { Compiler } from './compiler';
import { GlyphReader } from '../format/glyph';
import { DEFAULT_PARAMS, Mode } from '../types';

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

function paint(status?: string) {
  const passed = results.filter((r) => r.pass).length;
  document.getElementById('out')!.innerHTML =
    `<h3>${passed}/${results.length} passed${status ? ' — ' + status : ''}</h3>` +
    results
      .map(
        (r) =>
          `<div style="color:${r.pass ? '#6cff9a' : '#ff6b6b'}">${r.pass ? 'PASS' : 'FAIL'} — ${r.name}` +
          (r.detail ? ` <span style="color:#8a8a96">(${r.detail})</span>` : '') +
          '</div>',
      )
      .join('');
}

async function run() {
  const canvas = document.getElementById('gpu') as HTMLCanvasElement;
  const gpu = await initGPU(canvas);
  const atlas = buildGlyphAtlas(gpu.device);
  const params = { ...DEFAULT_PARAMS, cols: 120, cellPx: 6, mode: Mode.AsciiColor };
  const renderer = new Renderer(gpu, atlas, params);

  document.getElementById('out')!.textContent = 'fetching test clip…';
  const res = await fetch('/testclip.mp4');
  if (!res.ok) throw new Error('testclip.mp4 not found in public/');
  const file = new File([await res.blob()], 'testclip.mp4', { type: 'video/mp4' });

  const compiler = new Compiler(renderer, atlas.chars);

  document.getElementById('out')!.textContent = 'compiling…';
  const t0 = performance.now();
  const out = await compiler.compile(file, { color: true, keyInterval: 30 }, (p) => {
    document.getElementById('out')!.textContent = `compiling… frame ${p.frame}/${p.total}`;
  });
  const compileMs = performance.now() - t0;

  check('produced frames', out.frames > 60, `${out.frames} frames`);
  // 640x360 at 120 cols -> 120 * 360/640 = 67.5, which rounds to 68.
  const expectedRows = Math.round(120 * (360 / 640));
  check(
    'grid sized from video aspect',
    out.cols === 120 && out.rows === expectedRows,
    `${out.cols}x${out.rows}, expected ${expectedRows} rows`,
  );
  check('fps detected', Math.abs(out.fps - 30) < 2, String(out.fps));
  check('file is non-trivial', out.bytes > 1000, `${(out.bytes / 1024).toFixed(1)} KB`);

  // --- decode the whole chain ---------------------------------------------
  const buf = await out.blob!.arrayBuffer();
  const reader = await GlyphReader.open(buf);

  check('header round-trips', reader.meta.cols === out.cols && reader.meta.rows === out.rows);
  check('frameCount round-trips', reader.frameCount === out.frames, String(reader.frameCount));
  check('char table round-trips', reader.meta.chars.length === atlas.chars.length);

  const state = reader.newState();
  let decodeOk = true;
  let firstBad = -1;
  for (let i = 0; i < reader.frameCount; i++) {
    try {
      await reader.decodeInto(i, state);
    } catch (e) {
      decodeOk = false;
      if (firstBad < 0) firstBad = i;
      break;
    }
  }
  check('every frame decodes', decodeOk, firstBad >= 0 ? `failed at frame ${firstBad}` : `${reader.frameCount} frames`);

  // Decoding is deterministic: a second pass from a fresh state must land
  // byte-identical, which it cannot if the delta chain is order-dependent.
  const state2 = reader.newState();
  for (let i = 0; i < reader.frameCount; i++) await reader.decodeInto(i, state2);
  let identical = state.glyphs.length === state2.glyphs.length;
  for (let i = 0; identical && i < state.glyphs.length; i++) identical = state.glyphs[i] === state2.glyphs[i];
  check('decode is deterministic', identical);

  // --- text sanity ---------------------------------------------------------
  const text = reader.toText(state);
  const lines = text.split(String.fromCharCode(10));
  check('text has correct row count', lines.length === out.rows, `${lines.length} lines`);
  check('text rows have correct width', lines.every((l) => [...l].length === out.cols));
  const distinct = new Set([...text.replace(/\n/g, '')]).size;
  check('text uses a range of glyphs', distinct > 8, `${distinct} distinct characters`);

  // --- size ----------------------------------------------------------------
  const rawBytes = out.frames * out.cols * out.rows * 7;
  const ratio = rawBytes / out.bytes;
  check('compresses vs raw grid', ratio > 2, `${ratio.toFixed(1)}x smaller than raw`);

  // Same clip in mono, to separate glyph cost from colour cost.
  const monoOut = await compiler.compile(file, { color: false, keyInterval: 30 });
  const monoPerFrame = monoOut.bytes / monoOut.frames / 1024;
  check('mono is far smaller than colour', monoOut.bytes < out.bytes / 3,
    `mono ${(monoOut.bytes / 1024).toFixed(0)} KB vs colour ${(out.bytes / 1024).toFixed(0)} KB`);

  // Does storing colour at reduced precision still shrink the file now that an
  // adaptive coder is in front of it? If the model already codes the unused low
  // bits for nearly nothing, explicit bit-packing would add complexity for
  // nothing — worth measuring rather than assuming.
  const sweep: Record<string, number> = {};
  for (const bits of [8, 6, 5, 4, 3]) {
    const r = await compiler.compile(file, { color: true, colorBits: bits, keyInterval: 30 });
    sweep['bits' + bits] = +(r.bytes / 1024).toFixed(1);
  }
  check('lower colour precision still shrinks the file', sweep.bits4 < sweep.bits8,
    Object.entries(sweep).map(([k, v]) => `${k}=${v}KB`).join(' '));

  const perFrameKB = out.bytes / out.frames / 1024;
  const mbps = (out.bytes / out.frames) * out.fps * 8 / 1e6;

  (window as any).__COMPILE_TEST__ = {
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    frames: out.frames,
    grid: `${out.cols}x${out.rows}`,
    fps: out.fps,
    sizeKB: +(out.bytes / 1024).toFixed(1),
    perFrameKB: +perFrameKB.toFixed(2),
    streamMbps: +mbps.toFixed(2),
    colorBitsSweep: sweep,
    monoKB: +(monoOut.bytes / 1024).toFixed(1),
    monoPerFrameKB: +monoPerFrame.toFixed(2),
    monoMbps: +((monoOut.bytes / monoOut.frames) * monoOut.fps * 8 / 1e6).toFixed(2),
    compileSeconds: +(compileMs / 1000).toFixed(2),
    framesPerSecond: +(out.frames / (compileMs / 1000)).toFixed(1),
    results,
  };
  paint(
    `${out.bytes / 1024 | 0} KB, ${perFrameKB.toFixed(2)} KB/frame, ` +
      `${mbps.toFixed(2)} Mbps at ${out.fps}fps, compiled in ${(compileMs / 1000).toFixed(1)}s`,
  );
}

run().catch((e) => {
  (window as any).__COMPILE_TEST__ = { error: String(e) };
  document.getElementById('out')!.textContent = 'ERROR: ' + e.message;
  console.error(e);
});
