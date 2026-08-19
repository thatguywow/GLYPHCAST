import { demuxFile } from '../decode/demux';
import { Decoder } from '../decode/decoder';
import type { Renderer } from '../engine/renderer';
import { GlyphWriter, type GlyphGridFrame, type GlyphMeta } from '../format/glyph';
import type { VideoConfig } from '../types';

export interface CompileProgress {
  frame: number;
  total: number;
  /** Bytes written so far (compressed). */
  bytes: number;
}

export interface CompileResult {
  blob: Blob;
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

  async compile(
    file: File,
    opts: { color: boolean; keyInterval?: number },
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

    const fps = estimateFps(chunks);
    const meta: GlyphMeta = { cols, rows, fps, color: opts.color, chars: this.chars };
    const writer = new GlyphWriter(meta);

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
    for (;;) {
      if (this.cancelled) break;
      const frame = await nextFrame();
      if (!frame) break;

      this.renderer.renderOffscreen(frame, frame.displayWidth, frame.displayHeight);
      frame.close();

      const grid = await this.renderer.readGlyphGrid();
      packInto(state, grid, cells, opts.color);
      await writer.addFrame(state, opts.keyInterval ?? 120);

      count++;
      if (onProgress && count % 5 === 0) {
        onProgress({ frame: count, total: chunks.length, bytes: 0 });
      }
    }

    await feed;
    decoder.close();
    for (const f of queue) f.close();

    if (decodeError) throw new Error(`Decode failed: ${decodeError}`);

    const blob = writer.finish();
    onProgress?.({ frame: count, total: chunks.length, bytes: blob.size });

    return {
      blob,
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
) {
  for (let i = 0; i < cells; i++) state.glyphs[i] = grid.glyphs[i];
  if (!color) return;
  // Readback is RGBA; the container stores RGB.
  for (let i = 0; i < cells; i++) {
    const s = i * 4;
    const d = i * 3;
    state.fg![d] = grid.fg[s];
    state.fg![d + 1] = grid.fg[s + 1];
    state.fg![d + 2] = grid.fg[s + 2];
    state.bg![d] = grid.bg[s];
    state.bg![d + 1] = grid.bg[s + 1];
    state.bg![d + 2] = grid.bg[s + 2];
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
