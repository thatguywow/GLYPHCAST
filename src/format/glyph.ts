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
 * compresses substantially better. Payloads use deflate-raw via the platform
 * CompressionStream, so there is no third-party codec dependency.
 *
 * Key frames carry every cell. Delta frames carry only cells whose glyph OR
 * colour changed, addressed by a CHANGED-CELL BITMAP (one bit per cell) rather
 * than a list of indices. On real footage roughly a third of cells move each
 * frame, and a 4-byte index each made the address list larger than the cell data
 * it pointed at; a bitmap costs 1 bit per cell regardless of how many changed.
 */

const MAGIC = 'GLYPHCST';
const VERSION = 2;
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

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([data as BufferSource]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data as BufferSource]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
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

    let isKey = !this.prev || this.frames % keyInterval === 0;
    let payload = isKey ? this.encodeKey(frame) : this.encodeDelta(this.prev!, frame);

    // A delta costs 4 index bytes per changed cell on top of the cell data, so
    // once enough of the grid has moved a full key frame is simply smaller —
    // and it also gives playback another resync point for free.
    if (!isKey && payload.length >= this.keySize()) {
      isKey = true;
      payload = this.encodeKey(frame);
    }

    const comp = await deflate(payload);

    const head = new Uint8Array(9);
    const dv = new DataView(head.buffer);
    dv.setUint8(0, isKey ? 0 : 1);
    dv.setUint32(1, payload.length, true);
    dv.setUint32(5, comp.length, true);

    await this.sink.write(head);
    await this.sink.write(comp);
    this.bytes += head.length + comp.length;
    this.frames++;
    // Deltas are computed against the previous frame, so keep an owned copy.
    this.prev = {
      glyphs: frame.glyphs.slice(),
      fg: frame.fg ? frame.fg.slice() : undefined,
      bg: frame.bg ? frame.bg.slice() : undefined,
    };
  }

  private keySize(): number {
    return this.cells + (this.meta.color ? this.cells * 6 : 0);
  }

  private encodeKey(f: GlyphGridFrame): Uint8Array {
    const n = this.cells;
    const color = this.meta.color;
    const out = new Uint8Array(n + (color ? n * 6 : 0));
    out.set(f.glyphs.subarray(0, n), 0);
    if (color) {
      out.set(f.fg!.subarray(0, n * 3), n);
      out.set(f.bg!.subarray(0, n * 3), n + n * 3);
    }
    return out;
  }

  private encodeDelta(prev: GlyphGridFrame, cur: GlyphGridFrame): Uint8Array {
    const color = this.meta.color;
    const n = this.cells;
    const mapBytes = (n + 7) >> 3;
    const bitmap = new Uint8Array(mapBytes);
    const changed: number[] = [];

    for (let i = 0; i < n; i++) {
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
      if (diff) {
        bitmap[i >> 3] |= 1 << (i & 7);
        changed.push(i);
      }
    }

    const k = changed.length;
    const out = new Uint8Array(mapBytes + k + (color ? k * 6 : 0));
    out.set(bitmap, 0);
    let o = mapBytes;
    for (let j = 0; j < k; j++) out[o + j] = cur.glyphs[changed[j]];
    o += k;
    if (color) {
      for (let j = 0; j < k; j++) {
        const c = changed[j] * 3;
        out[o + j * 3] = cur.fg![c];
        out[o + j * 3 + 1] = cur.fg![c + 1];
        out[o + j * 3 + 2] = cur.fg![c + 2];
      }
      o += k * 3;
      for (let j = 0; j < k; j++) {
        const c = changed[j] * 3;
        out[o + j * 3] = cur.bg![c];
        out[o + j * 3 + 1] = cur.bg![c + 1];
        out[o + j * 3 + 2] = cur.bg![c + 2];
      }
    }
    return out;
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

  /** Decodes frame `i` into `state` (mutated in place and returned). */
  async decodeInto(i: number, state: GlyphGridFrame): Promise<GlyphGridFrame> {
    const o = this.offsets[i];
    const dv = new DataView(this.data.buffer, this.data.byteOffset);
    const tag = dv.getUint8(o);
    const compLen = dv.getUint32(o + 5, true);
    const payload = await inflate(this.data.subarray(o + 9, o + 9 + compLen));
    const color = this.meta.color;
    const n = this.cells;

    if (tag === 0) {
      state.glyphs.set(payload.subarray(0, n));
      if (color) {
        state.fg!.set(payload.subarray(n, n + n * 3));
        state.bg!.set(payload.subarray(n + n * 3, n + n * 6));
      }
    } else {
      // Walk the changed-cell bitmap; payload planes are in the same bit order.
      const mapBytes = (n + 7) >> 3;
      const idx: number[] = [];
      for (let i = 0; i < n; i++) {
        if (payload[i >> 3] & (1 << (i & 7))) idx.push(i);
      }
      const k = idx.length;
      let p = mapBytes;
      for (let j = 0; j < k; j++) state.glyphs[idx[j]] = payload[p + j];
      p += k;
      if (color) {
        for (let j = 0; j < k; j++) {
          const c = idx[j] * 3;
          state.fg![c] = payload[p + j * 3];
          state.fg![c + 1] = payload[p + j * 3 + 1];
          state.fg![c + 2] = payload[p + j * 3 + 2];
        }
        p += k * 3;
        for (let j = 0; j < k; j++) {
          const c = idx[j] * 3;
          state.bg![c] = payload[p + j * 3];
          state.bg![c + 1] = payload[p + j * 3 + 1];
          state.bg![c + 2] = payload[p + j * 3 + 2];
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
