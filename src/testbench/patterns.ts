// Deterministic reference frames for the quality harness. Each returns a filled
// canvas. They are static (no time) so metrics are reproducible run to run.

export type PatternName = 'gradient' | 'bars' | 'scene';

export function makePattern(name: PatternName, w = 960, h = 540): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;

  if (name === 'gradient') {
    // Smooth tonal + color ramps -> stresses the luminance ramp / tonal fidelity.
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#000');
    g.addColorStop(0.5, '#888');
    g.addColorStop(1, '#fff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h / 2);
    const g2 = ctx.createLinearGradient(0, 0, w, 0);
    g2.addColorStop(0, '#f00');
    g2.addColorStop(0.5, '#0f0');
    g2.addColorStop(1, '#00f');
    ctx.fillStyle = g2;
    ctx.fillRect(0, h / 2, w, h / 2);
  } else if (name === 'bars') {
    // Hard color bars + a bold wordmark -> stresses edges + color.
    const cols = ['#fff', '#ff0', '#0ff', '#0f0', '#f0f', '#f00', '#00f', '#000'];
    const bw = w / cols.length;
    cols.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(i * bw, 0, bw, h * 0.66);
    });
    ctx.fillStyle = '#111';
    ctx.fillRect(0, h * 0.66, w, h * 0.34);
    ctx.fillStyle = '#fff';
    ctx.font = `900 ${Math.floor(h * 0.22)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GLYPHCAST', w / 2, h * 0.83);
  } else {
    // "Scene": soft lit background + a subject shape + fine detail -> photo-like.
    const bg = ctx.createRadialGradient(w * 0.35, h * 0.4, 0, w * 0.5, h * 0.5, w * 0.7);
    bg.addColorStop(0, '#3a4a6a');
    bg.addColorStop(1, '#05070d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    // Subject: a bright rounded form with shading.
    const sub = ctx.createRadialGradient(w * 0.5, h * 0.45, 10, w * 0.5, h * 0.55, h * 0.4);
    sub.addColorStop(0, '#ffe0b0');
    sub.addColorStop(0.6, '#c07840');
    sub.addColorStop(1, '#201008');
    ctx.fillStyle = sub;
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.55, h * 0.28, h * 0.36, 0, 0, Math.PI * 2);
    ctx.fill();
    // Fine high-contrast detail (thin lines) -> hard test for a cell grid.
    ctx.strokeStyle = '#e0f0ff';
    ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      ctx.moveTo(w * 0.1 + i * 12, h * 0.1);
      ctx.lineTo(w * 0.1 + i * 12, h * 0.3);
      ctx.stroke();
    }
  }
  return cv;
}

export const ALL_PATTERNS: PatternName[] = ['gradient', 'bars', 'scene'];
