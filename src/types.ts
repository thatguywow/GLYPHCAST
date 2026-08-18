export interface VideoConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
}

export interface RenderParams {
  /** Horizontal cell count (ASCII "columns"). Grid rows derive from video aspect. */
  cols: number;
  /** Output pixels per cell. cols * cellPx = canvas width. 320 cols * 6px = 1920. */
  cellPx: number;
  /** 0 = mono (tint), 1 = original color. */
  colorMode: number;
  edgeEnable: boolean;
  /** Sobel gradient magnitude above which a cell renders as a directional edge glyph. */
  edgeThreshold: number;
  /** RGB (0..1) used in mono mode. */
  tint: [number, number, number];
}

export const DEFAULT_PARAMS: RenderParams = {
  cols: 320,
  cellPx: 6,
  colorMode: 1,
  edgeEnable: true,
  edgeThreshold: 0.18,
  tint: [0.6, 1.0, 0.6],
};
