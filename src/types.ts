export interface VideoConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
}

/**
 * Render mode. Ascending fidelity, descending "text" character.
 * Block modes divide each cell into real-colour sub-cells; more divisions means
 * more detail and more cost, converging on plain video.
 */
export enum Mode {
  AsciiMono = 0,
  AsciiColor = 1,
  HalfBlock = 2, // 1x2
  QuarterBlock = 3, // 2x2
  FullBlock = 4, // 1x1 mosaic
  Sextant = 5, // 2x3
  Octant = 6, // 2x4
  Hex = 7, // 4x4 — highest fidelity, highest cost
}

export interface RenderParams {
  /** Horizontal cell count. Grid rows derive from video aspect. */
  cols: number;
  /** Desired output pixels per cell. Reduced automatically to respect maxWidth. */
  cellPx: number;
  /** Hard cap on output width. Keeps the render target sane regardless of cols. */
  maxWidth: number;
  mode: number;
  /** Per-cell glyph shape matching (max quality). Off = fast luminance ramp. */
  matchGlyphs: boolean;
  /**
   * Temporal hysteresis: keep the previous frame's glyph when its match error is
   * within this fraction of the best glyph's. Kills the shimmer that appears when
   * two glyphs score nearly equal and the winner flips frame to frame.
   * 0 disables it.
   */
  hysteresis: number;
  /**
   * ASCII colour detail, 0..1. At 0 each cell is flat: one foreground and one
   * background colour. Above 0 the glyph is tinted by the source colour sampled
   * per output pixel.
   *
   * LIVE PREVIEW ONLY. A compiled .glyph stores one foreground and one background
   * per cell, so this cannot be reproduced from a file — it defaults to 0 so what
   * the preview shows is what compiling actually produces. A preview that looks
   * better than the output is worse than no preview.
   */
  colorDetail: number;
  /** Output brightness multiplier applied before gamma. */
  gain: number;
  /** Output gamma. >1 lifts midtones. */
  gamma: number;
  /** RGB (0..1) used in mono mode. */
  tint: [number, number, number];
}

export const DEFAULT_PARAMS: RenderParams = {
  cols: 320,
  cellPx: 6,
  maxWidth: 1920,
  mode: Mode.AsciiColor,
  matchGlyphs: true,
  hysteresis: 0.18,
  colorDetail: 0,
  gain: 1.0,
  gamma: 1.0,
  tint: [0.65, 1.0, 0.72],
};
