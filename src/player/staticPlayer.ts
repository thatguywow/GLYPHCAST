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
 *
 * When the file carries audio, the audio element is the clock. Audio glitches
 * far more audibly than dropped frames show, so the picture is scheduled against
 * sound rather than the other way round; without audio a wall clock is used.
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

  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;

  onStats?: (s: StaticStats) => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;

  constructor(private renderer: Renderer) {}

  async load(buffer: ArrayBuffer) {
    this.stop();
    this.releaseAudio();

    this.reader = await GlyphReader.open(buffer);
    this.state = this.reader.newState();
    this.index = -1;

    const track = this.reader.meta.audio;
    if (track && track.length > 0) {
      // Copy out of the file buffer: the view is a window onto the whole file.
      this.audioUrl = URL.createObjectURL(new Blob([track.slice() as BufferSource], { type: 'audio/mp4' }));
      this.audio = new Audio(this.audioUrl);
      this.audio.preload = 'auto';
    }

    this.renderer.setExternalGrid(this.reader.meta.cols, this.reader.meta.rows);
    await this.seekTo(0);
  }

  private releaseAudio() {
    this.audio?.pause();
    this.audio = null;
    if (this.audioUrl) {
      URL.revokeObjectURL(this.audioUrl);
      this.audioUrl = null;
    }
  }

  get hasAudio() {
    return !!this.audio;
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
    if (this.audio && this.reader) {
      this.audio.currentTime = clamped / (this.reader.meta.fps || 30);
    }
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

    if (this.audio) {
      this.audio.currentTime = this.startFrame / (this.reader.meta.fps || 30);
      void this.audio.play().catch(() => {
        // Autoplay was refused; the picture still runs on the wall clock.
        this.audio = null;
      });
    }
    void this.loop();
  }

  pause() {
    this.running = false;
    this.audio?.pause();
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

  /** Releases the audio object URL. Call when discarding the player. */
  dispose() {
    this.stop();
    this.releaseAudio();
  }

  private async loop() {
    while (this.running && this.reader && this.state) {
      const fps = this.reader.meta.fps || 30;
      // Audio is authoritative when present: the picture follows the sound.
      const target = this.audio
        ? Math.floor(this.audio.currentTime * fps)
        : this.startFrame + Math.floor(((performance.now() - this.startedAt) / 1000) * fps);

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
