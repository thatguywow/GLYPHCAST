import { demuxFile } from '../decode/demux';
import { Decoder } from '../decode/decoder';
import type { Renderer } from '../engine/renderer';
import type { VideoConfig } from '../types';

/** Decoded frames + in-flight decodes kept buffered ahead of playback. */
const TARGET_BUFFER = 12;

export interface PlayerStats {
  fps: number;
  /** 95th-percentile frame time in ms — the number that exposes judder. */
  p95: number;
  worst: number;
  buffered: number;
  dropped: number;
  currentTime: number;
  duration: number;
}

/**
 * Demux -> WebCodecs decode -> frame queue -> present against the audio clock.
 *
 * `audio.currentTime` only updates a few times per second, so using it raw makes
 * frames bunch up and judder. We interpolate it with performance.now() between
 * updates and resync whenever the element reports a new value, which keeps
 * presentation smooth while staying locked to audio over time.
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

  // Interpolated clock state.
  private lastAudioTime = -1;
  private lastAudioAt = 0;

  // Frame-time instrumentation.
  private times: number[] = [];
  private lastFrameAt = 0;
  private lastStatAt = 0;
  private frameCount = 0;
  private dropped = 0;

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
      (f) => this.frames.push(f),
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

  private pump() {
    if (!this.decoder) return;
    while (
      this.frames.length + this.decoder.queueSize < TARGET_BUFFER &&
      this.nextChunk < this.chunks.length
    ) {
      this.decoder.decode(this.chunks[this.nextChunk++]);
    }
  }

  /** Audio position in microseconds, interpolated between element updates. */
  private clock(now: number): number {
    const t = this.audio.currentTime;
    if (t !== this.lastAudioTime) {
      this.lastAudioTime = t;
      this.lastAudioAt = now;
      return t * 1e6;
    }
    return (t + (now - this.lastAudioAt) / 1000) * 1e6;
  }

  play() {
    if (this.running || !this.cfg) return;
    this.running = true;
    void this.audio.play().catch(() => {});
    const now = performance.now();
    this.lastStatAt = now;
    this.lastFrameAt = now;
    this.lastAudioTime = -1;
    this.frameCount = 0;
    this.dropped = 0;
    this.times = [];
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

  rerender() {
    this.renderer.render();
  }

  private loop = () => {
    if (!this.running) return;
    this.pump();

    const now = performance.now();
    const t = this.clock(now);

    // Frames arrive in presentation order; walk forward to the newest due frame.
    let idx = -1;
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i].timestamp <= t) idx = i;
      else break;
    }

    if (idx >= 0) {
      this.renderer.render(this.frames[idx]);
      // Everything before the presented frame is late — count and release it.
      for (let i = 0; i < idx; i++) {
        this.frames[i].close();
        this.dropped++;
      }
      this.frames[idx].close();
      this.frames.splice(0, idx + 1);

      this.frameCount++;
      this.times.push(now - this.lastFrameAt);
      this.lastFrameAt = now;
    }

    if (now - this.lastStatAt >= 500) {
      const sorted = [...this.times].sort((a, b) => a - b);
      const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
      this.onStats?.({
        fps: (this.frameCount * 1000) / (now - this.lastStatAt),
        p95: +p95.toFixed(1),
        worst: +(sorted[sorted.length - 1] ?? 0).toFixed(1),
        buffered: this.frames.length,
        dropped: this.dropped,
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
      });
      this.frameCount = 0;
      this.times = [];
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
