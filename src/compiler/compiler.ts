import { demuxFile, extractAudio } from '../decode/demux';
import { Decoder } from '../decode/decoder';
import type { Renderer } from '../engine/renderer';
import { GlyphWriter, type GlyphGridFrame, type GlyphMeta, type GlyphSink } from '../format/glyph';
import type { VideoConfig } from '../types';

export interface CompileProgress {
  frame: number;
  total: number;
  /** Bytes written so far (compressed). */
  bytes: number;
}

export interface CompileOptions {
  color: boolean;
  keyInterval?: number;
  /**
   * Bits kept per colour channel (default 5 = 32 levels). Quantising does two
   * jobs: it collapses the entropy deflate has to encode, and it gives the delta
   * comparison a noise tolerance. Without it, sensor noise nudges nearly every
   * cell by a value or two each frame, every cell counts as "changed", and delta
   * coding degenerates into a full frame plus a 4-byte index per cell.
   */
  colorBits?: number;
  /** Keep 1 frame in N. 2 halves the frame rate and roughly halves the file. */
  frameStride?: number;
  /** Embed the source's audio track in the output. Default true. */
  audio?: boolean;
  /**
   * Entropy coder. 'deflate' (default) decodes far faster, which on a delta
   * chain sets the playable frame rate; 'range' trades that for smaller files.
   */
  entropy?: 'deflate' | 'range';
  /** Where bytes go. Defaults to memory; pass a FileSink for long compiles. */
  sink?: GlyphSink;
  /**
   * Called with each grid as it is encoded, before compression. The buffers are
   * reused between frames, so copy anything that must outlive the call. Used by
   * the tests to compare what was written against what plays back.
   */
  onFrame?: (index: number, frame: GlyphGridFrame) => void;
}

export interface SourceInfo {
  width: number;
  height: number;
  fps: number;
  frames: number;
  seconds: number;
  codec: string;
  /**
   * Largest column count that still gains detail. Below roughly 2 source pixels
   * per cell the grid is sampling the same pixels repeatedly — the file grows
   * quadratically while the picture cannot improve.
   */
  maxUsefulCols: number;
}

export interface CompileResult {
  /** Bytes of embedded audio, 0 when the source had none. */
  audioBytes: number;
  /** Null when streaming to a file sink — the bytes went straight to disk. */
  blob: Blob | null;
  bytes: number;
  frames: number;
  cols: number;
  rows: number;
  fps: number;
  seconds: number;
}

/**
 * Walks every frame of a video and emits a .glyph file.
 *
 * Frames are processed strictly one at a time: a decoded VideoFrame is rendered,
 * its character grid is read back, encoded, and the frame is closed before the
 * next is pulled. Buffering the decode output instead would hold thousands of
 * full-resolution frames in GPU memory and fall over on anything feature length.
 * Decode input is throttled to keep the decoder's queue shallow for the same
 * reason.
 */
export class Compiler {
  private cancelled = false;

  constructor(
    private renderer: Renderer,
    private chars: string[],
  ) {}

  cancel() {
    this.cancelled = true;
  }

  /**
   * Reads the source's real dimensions, frame rate and length without decoding
   * anything — demuxing alone is enough, and it is fast.
   */
  async inspect(file: File): Promise<SourceInfo> {
    const chunks: EncodedVideoChunk[] = [];
    let cfg: VideoConfig | null = null;
    let err: string | null = null;
    await demuxFile(
      file,
      (c) => {
        cfg = c;
      },
      (c) => chunks.push(c),
      (e) => {
        err = e;
      },
    );
    if (err) throw new Error(err);
    if (!cfg) throw new Error('No video track found.');
    const config: VideoConfig = cfg;
    const fps = estimateFps(chunks);
    return {
      width: config.codedWidth,
      height: config.codedHeight,
      fps,
      frames: chunks.length,
      seconds: chunks.length / fps,
      codec: config.codec,
      maxUsefulCols: Math.max(40, Math.floor(config.codedWidth / 2)),
    };
  }

  async compile(
    file: File,
    opts: CompileOptions,
    onProgress?: (p: CompileProgress) => void,
  ): Promise<CompileResult> {
    this.cancelled = false;
    const t0 = performance.now();

    // 1. Demux everything up front. Chunks are still compressed, so this is cheap
    //    compared with holding decoded frames.
    const chunks: EncodedVideoChunk[] = [];
    let cfg: VideoConfig | null = null;
    let demuxError: string | null = null;

    await demuxFile(
      file,
      (c) => {
        cfg = c;
      },
      (chunk) => chunks.push(chunk),
      (e) => {
        demuxError = e;
      },
    );

    if (demuxError) throw new Error(demuxError);
    if (!cfg) throw new Error('No video track found.');
    const config: VideoConfig = cfg;
    if (!(await Decoder.isSupported(config))) {
      throw new Error(`Codec not supported by this browser: ${config.codec}`);
    }
    if (chunks.length === 0) throw new Error('No frames found in this file.');

    // 2. Size the grid from the real video dimensions before any readback.
    this.renderer.setSource(config.codedWidth, config.codedHeight);
    const [cols, rows] = this.renderer.grid;
    const cells = cols * rows;

    const stride = Math.max(1, Math.floor(opts.frameStride ?? 1));
    const sourceFps = estimateFps(chunks);
    const fps = sourceFps / stride;
    const shift = 8 - Math.max(1, Math.min(8, opts.colorBits ?? 5));

    // Audio is pulled before the frame walk so it can go in the header, which
    // keeps the compiled file a single self-contained artifact.
    const audio =
      opts.audio === false ? null : await extractAudio(file).catch(() => null);

    const meta: GlyphMeta = {
      cols,
      rows,
      fps,
      color: opts.color,
      chars: this.chars,
      audio: audio?.bytes,
      entropy: opts.entropy ?? 'deflate',
    };
    const writer = new GlyphWriter(meta, opts.sink);

    // Reused scratch so the per-frame path allocates nothing.
    const state: GlyphGridFrame = {
      glyphs: new Uint8Array(cells),
      fg: opts.color ? new Uint8Array(cells * 3) : undefined,
      bg: opts.color ? new Uint8Array(cells * 3) : undefined,
    };

    // 3. Decode with backpressure; a waiter is resolved whenever a frame lands.
    const queue: VideoFrame[] = [];
    let waiter: (() => void) | null = null;
    let finished = false;
    let decodeError: string | null = null;

    // Reads `waiter` fresh each call, so control-flow narrowing cannot collapse it.
    const wake = () => {
      const w = waiter;
      waiter = null;
      if (w) w();
    };

    const decoder = new Decoder(
      (f) => {
        queue.push(f);
        wake();
      },
      (e) => {
        decodeError = e;
        wake();
      },
    );
    decoder.configure(config);

    const feed = (async () => {
      for (let i = 0; i < chunks.length && !this.cancelled; i++) {
        // Keep the decoder queue shallow so decoded frames cannot pile up.
        while (decoder.queueSize > 8 && !this.cancelled) {
          await new Promise((r) => setTimeout(r, 0));
        }
        decoder.decode(chunks[i]);
      }
      await decoder.flush().catch(() => {});
      finished = true;
      wake();
    })();

    const nextFrame = async (): Promise<VideoFrame | null> => {
      while (queue.length === 0 && !finished && !decodeError) {
        await new Promise<void>((r) => {
          waiter = r;
        });
      }
      return queue.shift() ?? null;
    };

    // 4. Render -> read grid -> encode, one frame at a time.
    let count = 0;
    let seen = 0;
    for (;;) {
      if (this.cancelled) break;
      const frame = await nextFrame();
      if (!frame) break;

      // Every frame is analysed even when striding, so temporal hysteresis sees an
      // unbroken sequence and glyph choices stay stable. Frames that will not be
      // encoded skip the pixel pass entirely — the grid is all we need from them.
      const index = seen++;
      const keep = index % stride === 0;
      this.renderer.analyzeOnly(frame, frame.displayWidth, frame.displayHeight);
      frame.close();

      if (!keep) continue;

      const grid = await this.renderer.readGlyphGrid();
      packInto(state, grid, cells, opts.color, shift);
      opts.onFrame?.(count, state);
      await writer.addFrame(state, opts.keyInterval ?? 120);

      count++;
      if (onProgress && count % 5 === 0) {
        onProgress({ frame: count, total: Math.ceil(chunks.length / stride), bytes: writer.size });
      }
    }

    await feed;
    decoder.close();
    for (const f of queue) f.close();

    if (decodeError) throw new Error(`Decode failed: ${decodeError}`);

    const blob = await writer.finish();
    const bytes = writer.size;
    onProgress?.({ frame: count, total: count, bytes });

    return {
      blob,
      bytes,
      audioBytes: audio?.bytes.length ?? 0,
      frames: writer.frameCount,
      cols,
      rows,
      fps,
      seconds: (performance.now() - t0) / 1000,
    };
  }
}

/** Copies a readback grid into the packed layout the container expects. */
function packInto(
  state: GlyphGridFrame,
  grid: { glyphs: Uint32Array; fg: Uint8Array; bg: Uint8Array },
  cells: number,
  color: boolean,
  shift: number,
) {
  for (let i = 0; i < cells; i++) state.glyphs[i] = grid.glyphs[i];
  if (!color) return;
  // Readback is RGBA; the container stores RGB, quantised so that noise-level
  // differences collapse to identical bytes and the delta pass can skip them.
  const q = (v: number) => (v >> shift) << shift;
  for (let i = 0; i < cells; i++) {
    const s = i * 4;
    const d = i * 3;
    state.fg![d] = q(grid.fg[s]);
    state.fg![d + 1] = q(grid.fg[s + 1]);
    state.fg![d + 2] = q(grid.fg[s + 2]);
    state.bg![d] = q(grid.bg[s]);
    state.bg![d + 1] = q(grid.bg[s + 1]);
    state.bg![d + 2] = q(grid.bg[s + 2]);
  }
}

/** Frame rate from chunk timestamps, falling back to 30 if they are unusable. */
function estimateFps(chunks: EncodedVideoChunk[]): number {
  if (chunks.length < 2) return 30;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of chunks) {
    if (c.timestamp < lo) lo = c.timestamp;
    if (c.timestamp > hi) hi = c.timestamp;
  }
  const span = (hi - lo) / 1e6;
  if (!isFinite(span) || span <= 0) return 30;
  const fps = (chunks.length - 1) / span;
  return fps > 0 && fps < 240 ? +fps.toFixed(3) : 30;
}
