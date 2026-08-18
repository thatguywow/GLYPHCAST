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
  HalfBlock = 2, // 1x2 real-color sub-cells (near-native, still grid-of-glyphs feel)
  QuarterBlock = 3, // 2x2 real-color sub-cells (max detail)
  FullBlock = 4, // 1x1 colored cell (mosaic)
}

export interface RenderParams {
  /** Horizontal cell count. Grid rows derive from video aspect. */
  cols: number;
  /** Output pixels per cell. cols * cellPx = canvas width. */
  cellPx: number;
  mode: number;
  edgeEnable: boolean;
  /** Sobel magnitude above which a cell renders as a directional edge glyph (ASCII modes only). */
  edgeThreshold: number;
  /** Output brightness multiplier applied before gamma. */
  gain: number;
  /** Output gamma. >1 lifts shadows (brightens midtones). */
  gamma: number;
  /** Background floor for ASCII glyphs (0 = pure black gaps, higher = tinted cell bg). */
  bgFloor: number;
  /** RGB (0..1) used in mono mode. */
  tint: [number, number, number];
}

export const DEFAULT_PARAMS: RenderParams = {
  cols: 320,
  cellPx: 6,
  mode: Mode.AsciiColor,
  edgeEnable: true,
  edgeThreshold: 0.16,
  gain: 1.15,
  gamma: 1.15,
  bgFloor: 0.12,
  tint: [0.6, 1.0, 0.6],
};
