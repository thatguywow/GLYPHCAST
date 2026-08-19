import type { Renderer } from '../engine/renderer';
import { GlyphReader, type GlyphGridFrame } from '../format/glyph';

export interface StaticStats {
  frame: number;
  frames: number;
  fps: number;
  seconds: number;
  duration: number;
}

/**
 * Plays a compiled .glyph file. There is no video decoder here at all: frames are
 * inflated, the grid is uploaded, and the compositor draws it — which is the
 * whole point of compiling, and why playback works from static hosting with no
 * server and no codec support.
 *
 * Frames form a delta chain, so seeking forward means decoding through the
 * intervening frames rather than jumping. When playback falls behind the clock
 * it catches up by decoding without drawing, which keeps timing honest instead
 * of letting the picture drift away from the intended rate.
 */
export class StaticPlayer {
  private reader: GlyphReader | null = null;
  private state: GlyphGridFrame | null = null;
  private index = -1;
  private running = false;
  private startedAt = 0;
  private startFrame = 0;
  private raf = 0;

  private shown = 0;
  private lastStatAt = 0;

  onStats?: (s: StaticStats) => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;

  constructor(private renderer: Renderer) {}

  async load(buffer: ArrayBuffer) {
    this.stop();
    this.reader = await GlyphReader.open(buffer);
    this.state = this.reader.newState();
    this.index = -1;
    this.renderer.setExternalGrid(this.reader.meta.cols, this.reader.meta.rows);
    await this.seekTo(0);
  }

  get meta() {
    return this.reader?.meta ?? null;
  }

  get frameCount() {
    return this.reader?.frameCount ?? 0;
  }

  get isPlaying() {
    return this.running;
  }

  /** Decodes forward to `target`, drawing only the frame that lands. */
  private async seekTo(target: number): Promise<void> {
    if (!this.reader || !this.state) return;
    const clamped = Math.min(Math.max(0, target), this.reader.frameCount - 1);
    if (clamped < this.index) {
      // Backwards means replaying the chain from the start.
      this.state = this.reader.newState();
      this.index = -1;
    }
    while (this.index < clamped) {
      await this.reader.decodeInto(++this.index, this.state);
    }
    this.draw();
  }

  private draw() {
    if (!this.state) return;
    this.renderer.writeGrid(this.state.glyphs, this.state.fg, this.state.bg);
    this.renderer.renderGrid();
    this.shown++;
  }

  play() {
    if (this.running || !this.reader) return;
    this.running = true;
    this.startedAt = performance.now();
    this.startFrame = this.index < 0 ? 0 : this.index;
    this.lastStatAt = this.startedAt;
    this.shown = 0;
    void this.loop();
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  toggle() {
    if (this.running) this.pause();
    else this.play();
  }

  stop() {
    this.pause();
    this.index = -1;
  }

  private async loop() {
    while (this.running && this.reader && this.state) {
      const fps = this.reader.meta.fps || 30;
      const elapsed = (performance.now() - this.startedAt) / 1000;
      const target = this.startFrame + Math.floor(elapsed * fps);

      if (target >= this.reader.frameCount) {
        this.pause();
        this.onEnded?.();
        return;
      }

      try {
        while (this.index < target) {
          await this.reader.decodeInto(++this.index, this.state);
        }
      } catch (e) {
        this.pause();
        this.onError?.((e as Error).message);
        return;
      }
      this.draw();

      const now = performance.now();
      if (now - this.lastStatAt >= 500) {
        this.onStats?.({
          frame: this.index,
          frames: this.reader.frameCount,
          fps: (this.shown * 1000) / (now - this.lastStatAt),
          seconds: this.index / fps,
          duration: this.reader.frameCount / fps,
        });
        this.shown = 0;
        this.lastStatAt = now;
      }

      await new Promise<void>((r) => {
        this.raf = requestAnimationFrame(() => r());
      });
    }
  }

  /** Current frame as plain text. */
  text(): string {
    if (!this.reader || !this.state) return '';
    return this.reader.toText(this.state);
  }
}
