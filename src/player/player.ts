import { demuxFile } from '../decode/demux';
import { Decoder } from '../decode/decoder';
import type { Renderer } from '../engine/renderer';
import type { VideoConfig } from '../types';

/** How many decoded frames + in-flight decodes to keep buffered ahead of playback. */
const TARGET_BUFFER = 10;

export interface PlayerStats {
  fps: number;
  buffered: number;
  currentTime: number;
  duration: number;
}

/**
 * Orchestrates: demux -> WebCodecs decode -> frame queue -> present against the
 * audio master clock -> Renderer. The <audio> element owns the clock so A/V
 * stays locked even if rendering can't keep the video's native frame rate.
 */
export class Player {
  private audio = new Audio();
  private decoder: Decoder | null = null;
  private chunks: EncodedVideoChunk[] = [];
  private nextChunk = 0;
  private frames: VideoFrame[] = [];
  private cfg: VideoConfig | null = null;
  private raf = 0;
  private running = false;
  private objectUrl: string | null = null;

  private lastStatAt = performance.now();
  private frameCount = 0;

  onStats?: (s: PlayerStats) => void;
  onError?: (msg: string) => void;
  onReady?: () => void;

  constructor(private renderer: Renderer) {}

  async load(file: File) {
    this.reset();

    this.objectUrl = URL.createObjectURL(file);
    this.audio.src = this.objectUrl;
    this.audio.load();

    this.decoder = new Decoder(
      (f) => this.onFrame(f),
      (e) => this.onError?.(`Decoder: ${e}`),
    );

    await demuxFile(
      file,
      async (cfg) => {
        this.cfg = cfg;
        if (!(await Decoder.isSupported(cfg))) {
          this.onError?.(`Codec not supported by this browser: ${cfg.codec}. Try an H.264 MP4.`);
          return;
        }
        this.decoder!.configure(cfg);
        this.renderer.setSource(cfg.codedWidth, cfg.codedHeight);
        this.onReady?.();
      },
      (chunk) => this.chunks.push(chunk),
      (e) => this.onError?.(`Demux: ${e}`),
    );
  }

  private onFrame(f: VideoFrame) {
    // Decoder emits in presentation order, but keep it sorted defensively.
    this.frames.push(f);
    this.frames.sort((a, b) => a.timestamp - b.timestamp);
  }

  private pump() {
    if (!this.decoder) return;
    while (
      this.frames.length + this.decoder.queueSize < TARGET_BUFFER &&
      this.nextChunk < this.chunks.length
    ) {
      this.decoder.decode(this.chunks[this.nextChunk++]);
    }
  }

  play() {
    if (this.running || !this.cfg) return;
    this.running = true;
    void this.audio.play().catch(() => {
      /* Called from a user gesture, so autoplay policy is satisfied. */
    });
    this.lastStatAt = performance.now();
    this.frameCount = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  pause() {
    this.running = false;
    this.audio.pause();
    cancelAnimationFrame(this.raf);
  }

  toggle() {
    if (this.running) this.pause();
    else this.play();
  }

  get isPlaying() {
    return this.running;
  }

  /** Re-render the current frame without advancing (for live param edits). */
  rerender() {
    this.renderer.render();
  }

  private loop = () => {
    if (!this.running) return;
    this.pump();

    const t = this.audio.currentTime * 1e6;

    // Present the newest frame whose timestamp has been reached.
    let idx = -1;
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i].timestamp <= t) idx = i;
      else break;
    }

    if (idx >= 0) {
      this.renderer.render(this.frames[idx]);
      for (let i = 0; i <= idx; i++) this.frames[i].close();
      this.frames.splice(0, idx + 1);
      this.frameCount++;
    }

    const now = performance.now();
    if (now - this.lastStatAt >= 500) {
      this.onStats?.({
        fps: (this.frameCount * 1000) / (now - this.lastStatAt),
        buffered: this.frames.length,
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
      });
      this.frameCount = 0;
      this.lastStatAt = now;
    }

    this.raf = requestAnimationFrame(this.loop);
  };

  reset() {
    this.pause();
    for (const f of this.frames) f.close();
    this.frames = [];
    this.chunks = [];
    this.nextChunk = 0;
    this.decoder?.close();
    this.decoder = null;
    this.cfg = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
