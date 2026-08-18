/**
 * Procedural animated source. Draws a colorful, high-contrast scene to a 2D
 * canvas each frame and hands it to a callback. Lets you exercise the full glyph
 * GPU renderer with no video file and no server — purely to tune the look.
 *
 * The scene is designed to stress every path: smooth gradients (luminance ramp),
 * hard rotating bars + bold text (Sobel edge glyphs), saturated colors (color mode).
 */
export class DemoSource {
  private cv = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private running = false;
  private t0 = 0;

  private frames = 0;
  private lastStat = 0;

  onFrame?: (cv: HTMLCanvasElement, w: number, h: number) => void;
  onStats?: (fps: number) => void;

  constructor(w = 960, h = 540) {
    this.cv.width = w;
    this.cv.height = h;
    this.ctx = this.cv.getContext('2d')!;
  }

  get isRunning() {
    return this.running;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.t0 = performance.now();
    this.lastStat = this.t0;
    this.frames = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private loop = () => {
    if (!this.running) return;
    const t = (performance.now() - this.t0) / 1000;
    this.draw(t);
    this.onFrame?.(this.cv, this.cv.width, this.cv.height);

    this.frames++;
    const now = performance.now();
    if (now - this.lastStat >= 500) {
      this.onStats?.((this.frames * 1000) / (now - this.lastStat));
      this.frames = 0;
      this.lastStat = now;
    }

    this.raf = requestAnimationFrame(this.loop);
  };

  private draw(t: number) {
    const { ctx, cv } = this;
    const W = cv.width;
    const H = cv.height;

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#04060a');
    bg.addColorStop(1, '#0a0410');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Soft moving color blobs -> smooth luminance for the ramp.
    for (let i = 0; i < 4; i++) {
      const a = t * 0.6 + (i * Math.PI) / 2;
      const x = W * 0.5 + Math.cos(a * 1.3 + i) * W * 0.32;
      const y = H * 0.5 + Math.sin(a * 1.7 + i) * H * 0.32;
      const r = 120 + 60 * Math.sin(t * 1.1 + i);
      const hue = (i * 90 + t * 40) % 360;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `hsla(${hue}, 90%, 60%, 0.9)`);
      g.addColorStop(1, `hsla(${hue}, 90%, 60%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Rotating hard bars -> strong directional edges.
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(t * 0.3);
    ctx.globalAlpha = 0.5;
    for (let i = -3; i <= 3; i++) {
      ctx.fillStyle = i % 2 ? '#0ff' : '#f0a';
      ctx.fillRect(-W, i * 40, W * 2, 18);
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // Bouncing bold wordmark -> lots of glyph-scale edges.
    ctx.save();
    const tx = W / 2 + Math.cos(t * 0.9) * W * 0.16;
    const ty = H / 2 + Math.sin(t * 1.3) * H * 0.16;
    ctx.translate(tx, ty);
    ctx.rotate(Math.sin(t * 0.5) * 0.15);
    ctx.font = `900 ${Math.floor(H * 0.18)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('GLYPHCAST', 0, 0);
    ctx.restore();
  }
}
