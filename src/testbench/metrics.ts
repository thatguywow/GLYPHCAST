// Objective image-quality metrics. All operate on RGBA byte arrays of equal size.
// Used by the headless harness so quality can be measured without a human eye.

export interface Metrics {
  psnr: number; // dB, higher = closer to reference (Inf shown as 99)
  ssim: number; // 0..1, higher = more structurally similar
  edgePreservation: number; // 0..1, correlation of Sobel edge maps
  lumaMeanRef: number; // 0..255
  lumaMeanOut: number;
  lumaContrastRef: number; // stddev
  lumaContrastOut: number;
}

function luma(rgba: Uint8ClampedArray, i: number): number {
  return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
}

function lumaPlane(rgba: Uint8ClampedArray, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = luma(rgba, p * 4);
  return out;
}

function mse(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  const n = a.length;
  for (let i = 0; i < n; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] - b[i + c];
      sum += d * d;
    }
  }
  return sum / ((n / 4) * 3);
}

function psnr(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const m = mse(a, b);
  if (m <= 1e-9) return 99;
  return 10 * Math.log10((255 * 255) / m);
}

/** Mean SSIM over 8x8 non-overlapping blocks, on the luma plane. */
function ssim(ref: Float64Array, out: Float64Array, w: number, h: number): number {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const B = 8;
  let acc = 0;
  let count = 0;
  for (let by = 0; by + B <= h; by += B) {
    for (let bx = 0; bx + B <= w; bx += B) {
      let mr = 0, mo = 0;
      for (let y = 0; y < B; y++)
        for (let x = 0; x < B; x++) {
          const idx = (by + y) * w + (bx + x);
          mr += ref[idx];
          mo += out[idx];
        }
      const n = B * B;
      mr /= n;
      mo /= n;
      let vr = 0, vo = 0, cov = 0;
      for (let y = 0; y < B; y++)
        for (let x = 0; x < B; x++) {
          const idx = (by + y) * w + (bx + x);
          const dr = ref[idx] - mr;
          const do_ = out[idx] - mo;
          vr += dr * dr;
          vo += do_ * do_;
          cov += dr * do_;
        }
      vr /= n - 1;
      vo /= n - 1;
      cov /= n - 1;
      const s = ((2 * mr * mo + C1) * (2 * cov + C2)) / ((mr * mr + mo * mo + C1) * (vr + vo + C2));
      acc += s;
      count++;
    }
  }
  return count ? acc / count : 0;
}

function sobelMag(plane: Float64Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  const at = (x: number, y: number) => plane[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      out[y * w + x] = Math.hypot(gx, gy);
    }
  return out;
}

/** Pearson correlation of two Sobel magnitude maps. */
function edgeCorrelation(ref: Float64Array, out: Float64Array, w: number, h: number): number {
  const er = sobelMag(ref, w, h);
  const eo = sobelMag(out, w, h);
  const n = w * h;
  let mr = 0, mo = 0;
  for (let i = 0; i < n; i++) {
    mr += er[i];
    mo += eo[i];
  }
  mr /= n;
  mo /= n;
  let cov = 0, vr = 0, vo = 0;
  for (let i = 0; i < n; i++) {
    const dr = er[i] - mr;
    const do_ = eo[i] - mo;
    cov += dr * do_;
    vr += dr * dr;
    vo += do_ * do_;
  }
  const denom = Math.sqrt(vr * vo);
  return denom < 1e-9 ? 0 : Math.max(0, cov / denom);
}

function stats(plane: Float64Array): { mean: number; std: number } {
  const n = plane.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += plane[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = plane[i] - mean;
    v += d * d;
  }
  return { mean, std: Math.sqrt(v / n) };
}

export function computeMetrics(
  reference: Uint8ClampedArray,
  output: Uint8ClampedArray,
  w: number,
  h: number,
): Metrics {
  const refL = lumaPlane(reference, w, h);
  const outL = lumaPlane(output, w, h);
  const rs = stats(refL);
  const os = stats(outL);
  return {
    psnr: +psnr(reference, output).toFixed(2),
    ssim: +ssim(refL, outL, w, h).toFixed(4),
    edgePreservation: +edgeCorrelation(refL, outL, w, h).toFixed(4),
    lumaMeanRef: +rs.mean.toFixed(1),
    lumaMeanOut: +os.mean.toFixed(1),
    lumaContrastRef: +rs.std.toFixed(1),
    lumaContrastOut: +os.std.toFixed(1),
  };
}
