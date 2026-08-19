// End-to-end playback check: compile a real MP4, then play the result back and
// confirm every frame that comes out of the player is byte-identical to the grid
// the compiler put in. This exercises the whole chain at once — compiler,
// container, reader, grid upload and compositor — on real footage rather than
// synthetic data.

import { initGPU } from '../engine/gpu';
import { buildGlyphAtlas } from '../engine/glyphAtlas';
import { Renderer } from '../engine/renderer';
import { Compiler } from '../compiler/compiler';
import { StaticPlayer } from './staticPlayer';
import { GlyphReader, type GlyphGridFrame } from '../format/glyph';
import { DEFAULT_PARAMS, Mode } from '../types';

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function run() {
  const canvas = document.getElementById('gpu') as HTMLCanvasElement;
  const gpu = await initGPU(canvas);
  const atlas = buildGlyphAtlas(gpu.device);

  // Hysteresis off so the compile is deterministic and reproducible.
  const params = {
    ...DEFAULT_PARAMS,
    cols: 100,
    cellPx: 6,
    mode: Mode.AsciiColor,
    hysteresis: 0,
  };
  const renderer = new Renderer(gpu, atlas, params);

  document.getElementById('out')!.textContent = 'compiling…';
  const res = await fetch('/testclip.mp4');
  const file = new File([await res.blob()], 'testclip.mp4', { type: 'video/mp4' });

  // Full colour precision so playback must reproduce the grid exactly.
  const written: GlyphGridFrame[] = [];
  const compiler = new Compiler(renderer, atlas.chars);
  const out = await compiler.compile(file, {
    color: true,
    colorBits: 8,
    keyInterval: 12,
    onFrame: (_i, f) => {
      written.push({ glyphs: f.glyphs.slice(), fg: f.fg!.slice(), bg: f.bg!.slice() });
    },
  });

  check('compiled frames', out.frames === written.length, `${out.frames} frames`);

  // --- playback reproduces every grid exactly ------------------------------
  document.getElementById('out')!.textContent = 'verifying playback…';
  const reader = await GlyphReader.open(await out.blob!.arrayBuffer());
  const state = reader.newState();
  let exact = true;
  let firstBad = -1;
  for (let i = 0; i < reader.frameCount; i++) {
    await reader.decodeInto(i, state);
    const ok =
      eq(state.glyphs, written[i].glyphs) &&
      eq(state.fg!, written[i].fg!) &&
      eq(state.bg!, written[i].bg!);
    if (!ok && firstBad < 0) firstBad = i;
    exact &&= ok;
  }
  check('playback reproduces every grid exactly', exact,
    firstBad >= 0 ? `first mismatch at frame ${firstBad}` : `${reader.frameCount} frames on real video`);

  // --- the player drives the renderer and actually draws -------------------
  const player = new StaticPlayer(renderer);
  await player.load(await out.blob!.arrayBuffer());

  check('player reads metadata', player.meta!.cols === out.cols && player.meta!.rows === out.rows,
    `${player.meta!.cols}x${player.meta!.rows}`);
  check('player frame count', player.frameCount === out.frames, String(player.frameCount));

  const shot = await renderer.readback();
  let lit = 0;
  for (let i = 0; i < shot.rgba.length; i += 4) {
    if (shot.rgba[i] > 8 || shot.rgba[i + 1] > 8 || shot.rgba[i + 2] > 8) lit++;
  }
  const litFraction = lit / (shot.rgba.length / 4);
  check('compositor draws a real picture', litFraction > 0.05,
    `${(litFraction * 100).toFixed(1)}% of pixels lit at ${shot.width}x${shot.height}`);

  const text = player.text();
  check('player emits text', text.split(String.fromCharCode(10)).length === out.rows,
    `${text.length} characters`);

  // --- seeking -------------------------------------------------------------
  await (player as any).seekTo(out.frames - 1);
  const lastText = player.text();
  await (player as any).seekTo(0);
  const firstText = player.text();
  check('seek changes the picture', lastText !== firstText);

  await (player as any).seekTo(out.frames - 1);
  check('seek is repeatable', player.text() === lastText);

  const passed = results.filter((r) => r.pass).length;
  (window as any).__PLAYER_TEST__ = { passed, total: results.length, results };
  document.getElementById('out')!.innerHTML =
    `<h3>${passed}/${results.length} passed</h3>` +
    results
      .map(
        (r) =>
          `<div style="color:${r.pass ? '#6cff9a' : '#ff6b6b'}">${r.pass ? 'PASS' : 'FAIL'} — ${r.name}` +
          (r.detail ? ` <span style="color:#8a8a96">(${r.detail})</span>` : '') +
          '</div>',
      )
      .join('');
}

run().catch((e) => {
  (window as any).__PLAYER_TEST__ = { error: String(e) };
  document.getElementById('out')!.textContent = 'ERROR: ' + e.message;
  console.error(e);
});
