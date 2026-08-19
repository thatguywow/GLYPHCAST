// Standalone round-trip check for the .glyph container. Run via format-test.html.
// Verifies that what the writer encodes is exactly what the reader reproduces,
// across key frames, delta frames, and a mono file — before anything is built on
// top of the format.

import { GlyphWriter, GlyphReader, type GlyphGridFrame, type GlyphMeta } from './glyph';

const results: { name: string; pass: boolean; detail: string }[] = [];

function check(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Deterministic pseudo-random frames so failures are reproducible. */
function makeFrames(meta: GlyphMeta, count: number, glyphCount: number): GlyphGridFrame[] {
  const n = meta.cols * meta.rows;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const frames: GlyphGridFrame[] = [];
  const glyphs = new Uint8Array(n);
  const fg = new Uint8Array(n * 3);
  const bg = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    glyphs[i] = Math.floor(rnd() * glyphCount);
    for (let c = 0; c < 3; c++) {
      fg[i * 3 + c] = Math.floor(rnd() * 256);
      bg[i * 3 + c] = Math.floor(rnd() * 256);
    }
  }
  frames.push({ glyphs: glyphs.slice(), fg: fg.slice(), bg: bg.slice() });

  // Subsequent frames change only a minority of cells — the delta path.
  for (let f = 1; f < count; f++) {
    for (let i = 0; i < n; i++) {
      if (rnd() < 0.15) {
        glyphs[i] = Math.floor(rnd() * glyphCount);
        fg[i * 3] = Math.floor(rnd() * 256);
        bg[i * 3 + 2] = Math.floor(rnd() * 256);
      }
    }
    frames.push({ glyphs: glyphs.slice(), fg: fg.slice(), bg: bg.slice() });
  }
  return frames;
}

async function run() {
  const chars = [' ', '.', ':', '=', '#', '@', '█'];

  // Both entropy coders must reproduce the grid exactly; they differ only in
  // size and speed, never in what comes back out.
  for (const entropy of ['deflate', 'range'] as const) {
    const meta: GlyphMeta = { cols: 32, rows: 10, fps: 30, color: true, chars, entropy };
    const frames = makeFrames(meta, 8, chars.length);
    const w = new GlyphWriter(meta);
    for (const f of frames) await w.addFrame(f, 3);
    const blob = (await w.finish())!;
    const r = await GlyphReader.open(await blob.arrayBuffer());
    check(`${entropy}: flag round-trips`, r.meta.entropy === entropy, String(r.meta.entropy));
    const state = r.newState();
    let ok = true;
    for (let i = 0; i < r.frameCount; i++) {
      await r.decodeInto(i, state);
      ok &&= eq(state.glyphs, frames[i].glyphs) && eq(state.fg!, frames[i].fg!) && eq(state.bg!, frames[i].bg!);
    }
    check(`${entropy}: every frame reproduces exactly`, ok, `${blob.size} bytes`);
  }

  // --- colour file, spanning key + delta frames ----------------------------
  {
    const meta: GlyphMeta = { cols: 40, rows: 12, fps: 30, color: true, chars };
    const frames = makeFrames(meta, 10, chars.length);
    const w = new GlyphWriter(meta);
    // keyInterval 4 so the file exercises both frame kinds.
    for (const f of frames) await w.addFrame(f, 4);
    const blob = (await w.finish())!;
    const r = await GlyphReader.open(await blob.arrayBuffer());

    check('color: header cols/rows', r.meta.cols === 40 && r.meta.rows === 12, `${r.meta.cols}x${r.meta.rows}`);
    check('color: fps', r.meta.fps === 30, String(r.meta.fps));
    check('color: frameCount', r.frameCount === 10, String(r.frameCount));
    check('color: char table', JSON.stringify(r.meta.chars) === JSON.stringify(chars));
    check('color: flag', r.meta.color === true);

    const state = r.newState();
    let allMatch = true;
    let firstBad = -1;
    for (let i = 0; i < r.frameCount; i++) {
      await r.decodeInto(i, state);
      const ok =
        eq(state.glyphs, frames[i].glyphs) &&
        eq(state.fg!, frames[i].fg!) &&
        eq(state.bg!, frames[i].bg!);
      if (!ok && firstBad < 0) firstBad = i;
      allMatch &&= ok;
    }
    check('color: every frame reproduces exactly', allMatch, firstBad >= 0 ? `first mismatch at frame ${firstBad}` : '');

    const bytes = blob.size;
    const raw = 10 * 40 * 12 * 7;
    check('color: compresses below raw', bytes < raw, `${bytes}B vs ${raw}B raw`);
  }

  // --- mono file -----------------------------------------------------------
  {
    const meta: GlyphMeta = { cols: 24, rows: 8, fps: 60, color: false, chars };
    const frames = makeFrames(meta, 5, chars.length);
    const w = new GlyphWriter(meta);
    for (const f of frames) await w.addFrame(f, 3);
    const r = await GlyphReader.open(await (await w.finish())!.arrayBuffer());

    check('mono: flag off', r.meta.color === false);
    const state = r.newState();
    check('mono: no colour planes allocated', state.fg === undefined && state.bg === undefined);
    let ok = true;
    for (let i = 0; i < r.frameCount; i++) {
      await r.decodeInto(i, state);
      ok &&= eq(state.glyphs, frames[i].glyphs);
    }
    check('mono: every frame reproduces exactly', ok);
  }

  // --- text rendering + rejection of junk ----------------------------------
  {
    const meta: GlyphMeta = { cols: 4, rows: 2, fps: 1, color: false, chars };
    const f: GlyphGridFrame = { glyphs: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 0]) };
    const w = new GlyphWriter(meta);
    await w.addFrame(f);
    const r = await GlyphReader.open(await (await w.finish())!.arrayBuffer());
    const state = r.newState();
    await r.decodeInto(0, state);
    const text = r.toText(state);
    check('text: exact characters', text === ' .:=\n#@█ ', JSON.stringify(text));

    let rejected = false;
    try {
      await GlyphReader.open(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer);
    } catch {
      rejected = true;
    }
    check('rejects non-glyph input', rejected);
  }

  const passed = results.filter((r) => r.pass).length;
  (window as any).__FORMAT_TEST__ = { passed, total: results.length, results };
  document.getElementById('out')!.innerHTML =
    `<h3>${passed}/${results.length} passed</h3>` +
    results
      .map(
        (r) =>
          `<div style="color:${r.pass ? '#6cff9a' : '#ff6b6b'}">${r.pass ? 'PASS' : 'FAIL'} — ${r.name}` +
          (r.detail ? ` <span style="color:#8a8a96">(${r.detail})</span>` : '') +
          `</div>`,
      )
      .join('');
}

run().catch((e) => {
  (window as any).__FORMAT_TEST__ = { error: String(e) };
  document.getElementById('out')!.textContent = 'ERROR: ' + e.message;
});
