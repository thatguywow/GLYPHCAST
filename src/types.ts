export interface VideoConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
}

/** Render mode. Higher = more fidelity, less "text" character. */
export enum Mode {
  AsciiMono = 0,
  AsciiColor = 1,
  HalfBlock = 2, // 1x2 real-color sub-cells
  QuarterBlock = 3, // 2x2 real-color sub-cells (max detail)
  FullBlock = 4, // 1x1 colored cell (mosaic)
}

export interface RenderParams {
  /** Horizontal cell count. Grid rows derive from video aspect. */
  cols: number;
  /** Desired output pixels per cell. Reduced automatically to respect maxWidth. */
  cellPx: number;
  /** Hard cap on output width. Keeps the render target sane (perf) regardless of cols. */
  maxWidth: number;
  mode: number;
  /** Per-cell glyph shape matching (max quality). Off = fast luminance ramp. */
  matchGlyphs: boolean;
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
  gain: 1.0,
  gamma: 1.0,
  tint: [0.65, 1.0, 0.72],
};
