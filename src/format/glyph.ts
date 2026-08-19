/**
 * The .glyph container: a compiled, self-contained character-grid animation.
 *
 * Layout (little-endian):
 *
 *   magic        8   "GLYPHCST"
 *   version      u16 = 1
 *   flags        u16 bit0 = per-cell colour present
 *   cols         u16
 *   rows         u16
 *   fps          f32
 *   frameCount   u32
 *   charTableLen u32
 *   charTable    UTF-8 JSON array of the glyph characters
 *   frames[]     each: tag u8 (0 = key, 1 = delta), rawLen u32, compLen u32, payload
 *
 * Payloads are stored PLANAR (all glyph indices, then all foreground bytes, then
 * all background bytes) rather than interleaved per cell, because neighbouring
 * cells correlate far more strongly within a plane than across one, so planar
 * codes substantially better. Each plane is entropy coded by an adaptive binary
 * range coder with its own model, replacing deflate — deflate cannot spend less
 * than one bit on a symbol, and our residual planes are overwhelmingly zeros,
 * which is precisely the distribution it handles worst.
 *
 * Key frames carry every cell. Delta frames carry only cells whose glyph OR
 * colour changed, addressed by a CHANGED-CELL BITMAP (one bit per cell) rather
 * than a list of indices. On real footage roughly a third of cells move each
 * frame, and a 4-byte index each made the address list larger than the cell data
 * it pointed at; a bitmap costs 1 bit per cell regardless of how many changed.
 *
 * Values are stored as PREDICTION RESIDUALS, not absolutes. Neighbouring cells
 * have similar colour, a cell's background resembles its foreground, and a cell
 * changes little between frames — so predicting from those and storing only the
 * difference leaves numbers clustered tightly around zero, which is what a
 * general-purpose compressor can actually exploit. Residuals are taken modulo
 * 256 and zigzag mapped (0, -1, 1, -2, 2 -> 0, 1, 2, 3, 4) so small differences
 * of either sign become small bytes. Every step is exactly reversible: this
 * changes only how the same grid is written, never the grid itself.
 *
 * Glyph indices are stored raw: predicting them was measured and made files
 * larger, because a glyph is chosen by shape and neighbouring choices are not
 * numerically close. Prediction is applied to colour only.
 *
 *   key frame   colour <- cell to the left; background <- its own foreground
 *   delta frame colour <- the same cell in the previous frame
 */

import { RangeEncoder, RangeDecoder, ByteModel } from './rangecoder';

const MAGIC = 'GLYPHCST';
const VERSION = 4;
export const FLAG_COLOR = 1;

export interface GlyphGridFrame {
  /** One glyph index per cell (row-major). */
  glyphs: Uint8Array;
  /** RGB triplets per cell, or undefined in mono files. */
  fg?: Uint8Array;
  bg?: Uint8Array;
}

export interface GlyphMeta {
  cols: number;
  rows: number;
  fps: number;
  color: boolean;
  chars: string[];
}

/** Signed residual -> byte, small magnitudes of either sign map to small bytes. */
function zig(cur: number, pred: number): number {
  const d = (cur - pred) & 0xff;
  const signed = d > 127 ? d - 256 : d;
  return ((signed << 1) ^ (signed >> 31)) & 0xff;
}

/** Inverse of zig(). */
function unzig(z: number, pred: number): number {
  const signed = (z >>> 1) ^ -(z & 1);
  return (pred + signed) & 0xff;
}

/**
 * Adaptive models, one set per plane, each split into contexts selected by the
 * PREVIOUS value in that plane, and PERSISTED ACROSS FRAMES.
 *
 * Both halves were needed. Plain order-0 coding measured level with deflate:
 * fractional-bit precision was won, LZ77 match finding was lost. Adding contexts
 * on top of per-frame models made it worse still — five contexts each saw a
 * fifth of the data and never finished adapting. Carrying the models across the
 * whole file gives every context enough history to sharpen, which is what an
 * adaptive coder needs and what a fresh deflate stream per frame can never do.
 *
 * The cost is that frames must be decoded in order. Playback already does that:
 * frames form a delta chain, so seeking backwards replays from the start anyway.
 */
const CTX = 5;

function bucket(v: number): number {
  if (v === 0) return 0;
  if (v <= 2) return 1;
  if (v <= 6) return 2;
  if (v <= 16) return 3;
  return 4;
}

class PlaneModel {
  private models: ByteModel[] = Array.from({ length: CTX }, () => new ByteModel());
  private prev = 0;

  encode(enc: RangeEncoder, value: number) {
    enc.encodeByte(this.models[bucket(this.prev)], value);
    this.prev = value;
  }

  decode(dec: RangeDecoder): number {
    const v = dec.decodeByte(this.models[bucket(this.prev)]);
    this.prev = v;
    return v;
  }
}

function newModels() {
  return {
    bitmap: new PlaneModel(),
    glyph: new PlaneModel(),
    fg: new PlaneModel(),
    bg: new PlaneModel(),
  };
}

/**
 * Where a writer puts its bytes. Accumulating a whole file in memory only works
 * for small ones — a few minutes at a large grid runs to gigabytes and will kill
 * the tab — so long compiles stream straight to disk instead.
 */
export interface GlyphSink {
  write(data: Uint8Array): Promise<void>;
  /** Rewrites a few bytes at a fixed offset (used to patch the frame count). */
  patch(offset: number, data: Uint8Array): Promise<void>;
  close(): Promise<Blob | null>;
}

/** Collects into memory and returns a Blob. Fine for short clips and tests. */
export class MemorySink implements GlyphSink {
  private parts: Uint8Array[] = [];
  private length = 0;

  async write(data: Uint8Array) {
    this.parts.push(data.slice());
    this.length += data.length;
  }

  async patch(offset: number, data: Uint8Array) {
    let seen = 0;
    for (const part of this.parts) {
      if (offset < seen + part.length) {
        part.set(data, offset - seen);
        return;
      }
      seen += part.length;
    }
  }

  async close(): Promise<Blob> {
    return new Blob(this.parts.map((p) => p as BufferSource), { type: 'application/octet-stream' });
  }

  get size() {
    return this.length;
  }
}

/** Streams to a file handle from showSaveFilePicker — constant memory. */
export class FileSink implements GlyphSink {
  private written = 0;
  constructor(private stream: FileSystemWritableFileStream) {}

  async write(data: Uint8Array) {
    await this.stream.write(data as BufferSource);
    this.written += data.length;
  }

  async patch(offset: number, data: Uint8Array) {
    await this.stream.write({ type: 'write', position: offset, data: data as BufferSource });
  }

  async close(): Promise<null> {
    await this.stream.close();
    return null;
  }

  get size() {
    return this.written;
  }
}

/** Builds a .glyph file frame by frame. */
export class GlyphWriter {
  private frames = 0;
  private prev: GlyphGridFrame | null = null;
  private cells: number;
  private sink: GlyphSink;
  private headerWritten = false;
  private bytes = 0;
  private models = newModels();

  constructor(
    private meta: GlyphMeta,
    sink?: GlyphSink,
  ) {
    this.cells = meta.cols * meta.rows;
    this.sink = sink ?? new MemorySink();
  }

  /** Bytes emitted so far. */
  get size() {
    return this.bytes;
  }

  private async writeHeader(): Promise<void> {
    const table = new TextEncoder().encode(JSON.stringify(this.meta.chars));
    const header = new Uint8Array(28 + table.length);
    const dv = new DataView(header.buffer);
    for (let i = 0; i < 8; i++) dv.setUint8(i, MAGIC.charCodeAt(i));
    dv.setUint16(8, VERSION, true);
    dv.setUint16(10, this.meta.color ? FLAG_COLOR : 0, true);
    dv.setUint16(12, this.meta.cols, true);
    dv.setUint16(14, this.meta.rows, true);
    dv.setFloat32(16, this.meta.fps, true);
    dv.setUint32(20, 0, true); // frame count patched in finish()
    dv.setUint32(24, table.length, true);
    header.set(table, 28);
    await this.sink.write(header);
    this.bytes += header.length;
    this.headerWritten = true;
  }

  /** Appends a frame, keyed every `keyInterval` frames so playback can resync. */
  async addFrame(frame: GlyphGridFrame, keyInterval = 120): Promise<void> {
    if (!this.headerWritten) await this.writeHeader();

    const n = this.cells;
    const per = 1 + (this.meta.color ? 6 : 0);
    let isKey = !this.prev || this.frames % keyInterval === 0;
    let changed: number[] | null = null;

    if (!isKey) {
      changed = this.changedCells(this.prev!, frame);
      // Compare the two encodings by their pre-coding size rather than coding
      // both: once enough of the grid has moved, sending everything is smaller
      // than a bitmap plus that many cells, and it adds a resync point for free.
      const deltaRaw = ((n + 7) >> 3) + changed.length * per;
      if (deltaRaw >= n * per) {
        isKey = true;
        changed = null;
      }
    }

    // Models carry across frames; the range coder itself is per frame so each
    // frame stays independently addressable in the file.
    const enc = new RangeEncoder();
    const m = this.models;
    if (isKey) this.codeKey(enc, frame, m);
    else this.codeDelta(enc, this.prev!, frame, changed!, m);
    const coded = enc.finish();

    const head = new Uint8Array(9);
    const dv = new DataView(head.buffer);
    dv.setUint8(0, isKey ? 0 : 1);
    dv.setUint32(1, n, true);
    dv.setUint32(5, coded.length, true);

    await this.sink.write(head);
    await this.sink.write(coded);
    this.bytes += head.length + coded.length;
    this.frames++;
    // Deltas are computed against the previous frame, so keep an owned copy.
    this.prev = {
      glyphs: frame.glyphs.slice(),
      fg: frame.fg ? frame.fg.slice() : undefined,
      bg: frame.bg ? frame.bg.slice() : undefined,
    };
  }

  private codeKey(enc: RangeEncoder, f: GlyphGridFrame, m: ReturnType<typeof newModels>) {
    const n = this.cells;

    // Glyph indices are coded raw. Predicting them from a neighbour was measured
    // and made things WORSE (mono grew 18%): glyphs are chosen by shape, so
    // adjacent cells jump around the table and the residual carries more entropy
    // than the index it replaced. Prediction only pays on smooth signals.
    for (let i = 0; i < n; i++) m.glyph.encode(enc, f.glyphs[i]);

    if (this.meta.color) {
      const fg = f.fg!;
      const bg = f.bg!;
      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < n; i++) {
          m.fg.encode(enc, zig(fg[i * 3 + c], i > 0 ? fg[(i - 1) * 3 + c] : 0));
        }
      }
      // Within a cell the background is usually a darker version of the
      // foreground, so predict it from the foreground rather than the neighbour.
      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < n; i++) {
          m.bg.encode(enc, zig(bg[i * 3 + c], fg[i * 3 + c]));
        }
      }
    }
  }

  /** Indices of cells whose glyph or colour differs from the previous frame. */
  private changedCells(prev: GlyphGridFrame, cur: GlyphGridFrame): number[] {
    const color = this.meta.color;
    const out: number[] = [];
    for (let i = 0; i < this.cells; i++) {
      let diff = prev.glyphs[i] !== cur.glyphs[i];
      if (!diff && color) {
        const c = i * 3;
        diff =
          prev.fg![c] !== cur.fg![c] ||
          prev.fg![c + 1] !== cur.fg![c + 1] ||
          prev.fg![c + 2] !== cur.fg![c + 2] ||
          prev.bg![c] !== cur.bg![c] ||
          prev.bg![c + 1] !== cur.bg![c + 1] ||
          prev.bg![c + 2] !== cur.bg![c + 2];
      }
      if (diff) out.push(i);
    }
    return out;
  }

  private codeDelta(
    enc: RangeEncoder,
    prev: GlyphGridFrame,
    cur: GlyphGridFrame,
    changed: number[],
    m: ReturnType<typeof newModels>,
  ) {
    const n = this.cells;
    const mapBytes = (n + 7) >> 3;
    const bitmap = new Uint8Array(mapBytes);
    for (const i of changed) bitmap[i >> 3] |= 1 << (i & 7);

    // The bitmap goes first so the decoder can recover the changed count from it.
    for (let i = 0; i < mapBytes; i++) m.bitmap.encode(enc, bitmap[i]);

    const k = changed.length;
    for (let j = 0; j < k; j++) m.glyph.encode(enc, cur.glyphs[changed[j]]);

    if (this.meta.color) {
      for (let c = 0; c < 3; c++) {
        for (let j = 0; j < k; j++) {
          const i = changed[j] * 3 + c;
          m.fg.encode(enc, zig(cur.fg![i], prev.fg![i]));
        }
      }
      for (let c = 0; c < 3; c++) {
        for (let j = 0; j < k; j++) {
          const i = changed[j] * 3 + c;
          m.bg.encode(enc, zig(cur.bg![i], prev.bg![i]));
        }
      }
    }
  }

  /** Patches the real frame count into the header and closes the sink. */
  async finish(): Promise<Blob | null> {
    if (!this.headerWritten) await this.writeHeader();
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, this.frames, true);
    await this.sink.patch(20, count);
    return this.sink.close();
  }

  get frameCount() {
    return this.frames;
  }
}

/** Sequentially decodes a .glyph file. */
export class GlyphReader {
  meta!: GlyphMeta;
  frameCount = 0;
  private data!: Uint8Array;
  private offsets: number[] = [];
  private cells = 0;
  private models = newModels();
  private nextIndex = 0;

  static async open(buffer: ArrayBuffer): Promise<GlyphReader> {
    const r = new GlyphReader();
    r.data = new Uint8Array(buffer);
    const dv = new DataView(buffer);

    let magic = '';
    for (let i = 0; i < 8; i++) magic += String.fromCharCode(dv.getUint8(i));
    if (magic !== MAGIC) throw new Error('Not a .glyph file.');
    const version = dv.getUint16(8, true);
    if (version !== VERSION) throw new Error(`Unsupported .glyph version ${version}.`);

    const flags = dv.getUint16(10, true);
    const tableLen = dv.getUint32(24, true);
    r.meta = {
      color: (flags & FLAG_COLOR) !== 0,
      cols: dv.getUint16(12, true),
      rows: dv.getUint16(14, true),
      fps: dv.getFloat32(16, true),
      chars: JSON.parse(new TextDecoder().decode(r.data.subarray(28, 28 + tableLen))),
    };
    r.frameCount = dv.getUint32(20, true);
    r.cells = r.meta.cols * r.meta.rows;

    // Index frame offsets up front so playback can seek without rescanning.
    let o = 28 + tableLen;
    for (let f = 0; f < r.frameCount; f++) {
      r.offsets.push(o);
      o += 9 + dv.getUint32(o + 5, true);
    }
    return r;
  }

  /**
   * Decodes frame `i` into `state` (mutated in place and returned).
   *
   * Models adapt across the whole file, so frames must be fed in order. Asking
   * for anything other than the next one rebuilds the model state by replaying
   * from the beginning — which the delta chain would require regardless.
   */
  async decodeInto(i: number, state: GlyphGridFrame): Promise<GlyphGridFrame> {
    if (i !== this.nextIndex) {
      this.models = newModels();
      for (let f = 0; f <= i; f++) await this.decodeFrame(f, state);
      this.nextIndex = i + 1;
      return state;
    }
    await this.decodeFrame(i, state);
    this.nextIndex = i + 1;
    return state;
  }

  private async decodeFrame(i: number, state: GlyphGridFrame): Promise<GlyphGridFrame> {
    const o = this.offsets[i];
    const dv = new DataView(this.data.buffer, this.data.byteOffset);
    const tag = dv.getUint8(o);
    const codedLen = dv.getUint32(o + 5, true);
    const dec = new RangeDecoder(this.data.subarray(o + 9, o + 9 + codedLen));
    const m = this.models;
    const color = this.meta.color;
    const n = this.cells;

    if (tag === 0) {
      for (let c = 0; c < n; c++) state.glyphs[c] = m.glyph.decode(dec);
      if (color) {
        const fg = state.fg!;
        const bg = state.bg!;
        for (let c = 0; c < 3; c++) {
          for (let p = 0; p < n; p++) {
            fg[p * 3 + c] = unzig(m.fg.decode(dec), p > 0 ? fg[(p - 1) * 3 + c] : 0);
          }
        }
        for (let c = 0; c < 3; c++) {
          for (let p = 0; p < n; p++) {
            bg[p * 3 + c] = unzig(m.bg.decode(dec), fg[p * 3 + c]);
          }
        }
      }
    } else {
      // Recover which cells changed, then read exactly that many values.
      const mapBytes = (n + 7) >> 3;
      const bitmap = new Uint8Array(mapBytes);
      for (let b = 0; b < mapBytes; b++) bitmap[b] = m.bitmap.decode(dec);

      const idx: number[] = [];
      for (let c = 0; c < n; c++) {
        if (bitmap[c >> 3] & (1 << (c & 7))) idx.push(c);
      }
      const k = idx.length;

      for (let j = 0; j < k; j++) state.glyphs[idx[j]] = m.glyph.decode(dec);

      if (color) {
        // state still holds the previous frame here, which is the predictor.
        for (let c = 0; c < 3; c++) {
          for (let j = 0; j < k; j++) {
            const p = idx[j] * 3 + c;
            state.fg![p] = unzig(m.fg.decode(dec), state.fg![p]);
          }
        }
        for (let c = 0; c < 3; c++) {
          for (let j = 0; j < k; j++) {
            const p = idx[j] * 3 + c;
            state.bg![p] = unzig(m.bg.decode(dec), state.bg![p]);
          }
        }
      }
    }
    return state;
  }

  /** Allocates a blank state buffer sized for this file. */
  newState(): GlyphGridFrame {
    const n = this.cells;
    return this.meta.color
      ? { glyphs: new Uint8Array(n), fg: new Uint8Array(n * 3), bg: new Uint8Array(n * 3) }
      : { glyphs: new Uint8Array(n) };
  }

  /** Renders the given state as plain text. */
  toText(state: GlyphGridFrame): string {
    const { cols, rows, chars } = this.meta;
    const lines: string[] = [];
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) line += chars[state.glyphs[y * cols + x]] ?? ' ';
      lines.push(line);
    }
    return lines.join(String.fromCharCode(10));
  }
}
