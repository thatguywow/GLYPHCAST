# GLYPHCAST

GPU-accelerated ASCII video engine. Decodes standard MP4 in the browser with
**WebCodecs**, renders **edge-aware** ASCII on the GPU with **WebGPU**, and plays
back at up to **1080p / 60 fps** with **zero backend**.

Spiritual successor to [ASCILINE](https://github.com/YusufB5/ASCILINE) — but instead
of a Python server encoding ASCII and streaming it over WebSocket, GLYPHCAST does
everything client-side on the GPU. The only thing that crosses the network is the
MP4 itself.

## Why this is fast

| | ASCILINE | GLYPHCAST |
|---|---|---|
| Decode | OpenCV (Python, CPU) | WebCodecs (hardware GPU decode) |
| ASCII conversion | NumPy per frame (CPU) | WGSL compute + fragment (GPU) |
| Transport | ASCII frames over WebSocket | none — MP4 downloads once |
| Backend | FastAPI + FFmpeg | static files |
| Target | ~30 fps, 200–240 cols | 60 fps, 320+ cols (1080p) |

A 320×180 cell grid at 1080p is ~57k cells — trivial for any modern GPU. The
bottleneck was never compute; it was CPU encode + streaming bandwidth. Removing
both is the whole leap.

## Pipeline

```
MP4 file
  │  mp4box.js          demux → EncodedVideoChunk (decode order)
  ▼
WebCodecs VideoDecoder  hardware decode → VideoFrame (presentation order)
  │  copyExternalImageToTexture
  ▼
WebGPU video texture
  │  Pass 1: downsample.wgsl (compute)   average color + luminance per cell
  ▼
cell buffer (cols × rows)
  │  Pass 2: ascii.wgsl (fragment)       Sobel edges → directional glyph,
  ▼                                       else luminance ramp; sample atlas; tint
Canvas (1920×1080)
```

Audio plays through an `<audio>` element that acts as the **master clock**; video
frames are presented when their timestamp reaches `audio.currentTime`, so A/V stays
locked even under GPU pressure (frames drop, audio never stalls).

### Edge-aware glyphs

Naive luminance mapping (`.:-=+*#%@`) looks flat. GLYPHCAST runs a **Sobel** filter
on the per-cell luminance; where the gradient is strong it picks a directional glyph
(`| / - \`) aligned to the edge. That's what makes outlines read as a drawing rather
than noise.

## Run locally

```bash
npm install
npm run dev
```

Open the printed URL, click **Open MP4…** (or drag one in). Chrome/Edge 113+ have
WebGPU + WebCodecs on by default; Safari 18+ works; Firefox needs WebGPU enabled.

Build:

```bash
npm run build && npm run preview
```

## Project layout

```
src/
  engine/
    gpu.ts              WebGPU device + canvas setup
    glyphAtlas.ts       rasterises glyphs into a texture atlas
    renderer.ts         compute + render passes, uniforms, resources
    shaders/
      downsample.wgsl   frame → per-cell average color + luminance
      ascii.wgsl        cell buffer → glyphs (Sobel edges + ramp)
  decode/
    demux.ts            mp4box → EncodedVideoChunk
    decoder.ts          WebCodecs VideoDecoder wrapper
  player/
    player.ts           decode buffer + audio-clock frame scheduling
  main.ts               UI wiring
  types.ts              shared types + defaults
```

## Roadmap

- [x] **Phase 1** — Core engine: MP4 → WebGPU edge-aware ASCII, audio-synced.
- [ ] **Phase 2** — More glyph sets, color grading, live tuning presets.
- [ ] **Phase 3** — Studio: trim + export ASCII back to MP4; `.glyph` static format.
- [ ] **Phase 4** — Streaming: HLS/DASH segments through WebCodecs (media-player replacement).
- [ ] **Phase 5** — GitHub Pages CI deploy.

## License

TBD.
