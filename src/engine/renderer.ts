import type { GPUContext } from './gpu';
import type { GlyphAtlas } from './glyphAtlas';
import type { RenderParams } from '../types';
import analyzeWGSL from './shaders/analyze.wgsl?raw';
import asciiWGSL from './shaders/ascii.wgsl?raw';

export class Renderer {
  private device: GPUDevice;
  private computePipeline: GPUComputePipeline;
  private renderPipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private aUniform: GPUBuffer;
  private rUniform: GPUBuffer;
  private sigBuffer: GPUBuffer;
  private rampBuffer: GPUBuffer;

  private videoTex: GPUTexture | null = null;
  private fgTex: GPUTexture | null = null;
  private bgTex: GPUTexture | null = null;
  private glyphTex: GPUTexture | null = null;
  private computeBG: GPUBindGroup | null = null;
  private renderBG: GPUBindGroup | null = null;

  // Reused readback resources (avoids per-capture allocation).
  private rbTexture: GPUTexture | null = null;
  private rbBuffer: GPUBuffer | null = null;
  private rbSize = { w: 0, h: 0, bytesPerRow: 0 };

  private videoW = 0;
  private videoH = 0;
  private gridW = 0;
  private gridH = 0;
  private params: RenderParams;

  constructor(
    private gpu: GPUContext,
    private atlas: GlyphAtlas,
    params: RenderParams,
  ) {
    this.device = gpu.device;
    this.params = params;
    const dev = this.device;

    this.computePipeline = dev.createComputePipeline({
      layout: 'auto',
      compute: { module: dev.createShaderModule({ code: analyzeWGSL }), entryPoint: 'main' },
    });

    const asciiModule = dev.createShaderModule({ code: asciiWGSL });
    this.renderPipeline = dev.createRenderPipeline({
      layout: 'auto',
      vertex: { module: asciiModule, entryPoint: 'vs' },
      fragment: { module: asciiModule, entryPoint: 'fs', targets: [{ format: gpu.format }] },
      primitive: { topology: 'triangle-list' },
    });

    this.sampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.aUniform = dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.rUniform = dev.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.sigBuffer = dev.createBuffer({
      size: atlas.signatures.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(this.sigBuffer, 0, atlas.signatures.buffer as ArrayBuffer);

    this.rampBuffer = dev.createBuffer({
      size: atlas.ramp.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(this.rampBuffer, 0, atlas.ramp.buffer as ArrayBuffer);
  }

  setSource(w: number, h: number) {
    if (w === this.videoW && h === this.videoH && this.videoTex) return;
    this.videoW = w;
    this.videoH = h;
    this.videoTex?.destroy();
    this.videoTex = this.device.createTexture({
      label: 'video-frame',
      size: [w, h, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.rebuild();
  }

  setParams(p: RenderParams) {
    this.params = p;
    this.rebuild();
  }

  get outputSize(): [number, number] {
    return [this.gpu.canvas.width, this.gpu.canvas.height];
  }

  get grid(): [number, number] {
    return [this.gridW, this.gridH];
  }

  private rebuild() {
    if (!this.videoTex || this.videoW === 0) return;
    const dev = this.device;

    const cols = Math.max(8, Math.floor(this.params.cols));
    const rows = Math.max(1, Math.round(cols * (this.videoH / this.videoW)));
    this.gridW = cols;
    this.gridH = rows;

    // Cap output resolution: a huge render target is the main source of frame-time
    // spikes, and past ~1080p it buys nothing visually.
    const cellPx = Math.max(2, Math.min(this.params.cellPx, Math.floor(this.params.maxWidth / cols)));
    this.gpu.canvas.width = cols * cellPx;
    this.gpu.canvas.height = rows * cellPx;

    this.fgTex?.destroy();
    this.bgTex?.destroy();
    this.glyphTex?.destroy();
    const cellUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.fgTex = dev.createTexture({ label: 'cell-fg', size: [cols, rows, 1], format: 'rgba8unorm', usage: cellUsage });
    this.bgTex = dev.createTexture({ label: 'cell-bg', size: [cols, rows, 1], format: 'rgba8unorm', usage: cellUsage });
    this.glyphTex = dev.createTexture({ label: 'cell-glyph', size: [cols, rows, 1], format: 'r32uint', usage: cellUsage });

    // Analyse uniforms (8 x u32).
    dev.queue.writeBuffer(
      this.aUniform,
      0,
      new Uint32Array([
        cols,
        rows,
        this.videoW,
        this.videoH,
        this.atlas.glyphCount,
        this.params.matchGlyphs ? 1 : 0,
        this.atlas.ramp.length,
        0,
      ]),
    );

    // Render uniforms (48 bytes, mixed u32/f32 — must match RU in ascii.wgsl).
    const buf = new ArrayBuffer(48);
    const dv = new DataView(buf);
    dv.setUint32(0, cols, true);
    dv.setUint32(4, rows, true);
    dv.setUint32(8, this.atlas.glyphCount, true);
    dv.setUint32(12, this.params.mode, true);
    dv.setFloat32(16, this.params.gain, true);
    dv.setFloat32(20, this.params.gamma, true);
    dv.setFloat32(24, this.params.tint[0], true);
    dv.setFloat32(28, this.params.tint[1], true);
    dv.setFloat32(32, this.params.tint[2], true);
    dev.queue.writeBuffer(this.rUniform, 0, buf);

    this.computeBG = dev.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.videoTex.createView() },
        { binding: 1, resource: this.fgTex.createView() },
        { binding: 2, resource: this.bgTex.createView() },
        { binding: 3, resource: this.glyphTex.createView() },
        { binding: 4, resource: { buffer: this.aUniform } },
        { binding: 5, resource: { buffer: this.sigBuffer } },
        { binding: 6, resource: { buffer: this.rampBuffer } },
      ],
    });
    this.renderBG = dev.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.fgTex.createView() },
        { binding: 1, resource: this.bgTex.createView() },
        { binding: 2, resource: this.glyphTex.createView() },
        { binding: 3, resource: this.atlas.texture.createView() },
        { binding: 4, resource: this.sampler },
        { binding: 5, resource: { buffer: this.rUniform } },
        { binding: 6, resource: this.videoTex.createView() },
        { binding: 7, resource: this.sampler },
      ],
    });
  }

  private ready(): boolean {
    return !!(this.videoTex && this.fgTex && this.computeBG && this.renderBG);
  }

  private uploadSource(
    source: VideoFrame | HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    srcW: number,
    srcH: number,
  ) {
    const a = source as { displayWidth?: number; width?: number; displayHeight?: number; height?: number };
    const w = srcW || a.displayWidth || a.width || 0;
    const h = srcH || a.displayHeight || a.height || 0;
    this.setSource(w, h);
    this.device.queue.copyExternalImageToTexture({ source: source as any }, { texture: this.videoTex! }, [w, h]);
  }

  private encode(targetView: GPUTextureView) {
    const enc = this.device.createCommandEncoder();

    const cp = enc.beginComputePass();
    cp.setPipeline(this.computePipeline);
    cp.setBindGroup(0, this.computeBG!);
    cp.dispatchWorkgroups(Math.ceil(this.gridW / 8), Math.ceil(this.gridH / 8), 1);
    cp.end();

    const rp = enc.beginRenderPass({
      colorAttachments: [
        { view: targetView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
      ],
    });
    rp.setPipeline(this.renderPipeline);
    rp.setBindGroup(0, this.renderBG!);
    rp.draw(3);
    rp.end();

    this.device.queue.submit([enc.finish()]);
  }

  render(
    source?: VideoFrame | HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    srcW = 0,
    srcH = 0,
  ) {
    if (source) this.uploadSource(source, srcW, srcH);
    if (!this.ready()) return;
    this.encode(this.gpu.context.getCurrentTexture().createView());
  }

  /** Runs the full render path into an offscreen target — for headless timing. */
  renderOffscreen(
    source?: VideoFrame | HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    srcW = 0,
    srcH = 0,
  ) {
    if (source) this.uploadSource(source, srcW, srcH);
    if (!this.ready()) return;
    const [w, h] = this.outputSize;
    if (!this.rbTexture || this.rbSize.w !== w || this.rbSize.h !== h) {
      this.rbTexture?.destroy();
      this.rbBuffer?.destroy();
      this.rbBuffer = null;
      this.rbTexture = this.device.createTexture({
        label: 'offscreen-target',
        size: [w, h, 1],
        format: this.gpu.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this.rbSize = { w, h, bytesPerRow: Math.ceil((w * 4) / 256) * 256 };
    }
    this.encode(this.rbTexture.createView());
  }

  /** Resolves once all submitted GPU work has completed. */
  deviceIdle(): Promise<undefined> {
    return this.device.queue.onSubmittedWorkDone();
  }

  /**
   * Headless render: draws to an offscreen texture and reads the pixels back.
   * Works with no visible canvas and no requestAnimationFrame.
   */
  async readback(
    source?: VideoFrame | HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    srcW = 0,
    srcH = 0,
  ): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
    if (source) this.uploadSource(source, srcW, srcH);
    if (!this.ready()) throw new Error('Renderer has no source to read back.');

    const [w, h] = this.outputSize;
    const bytesPerRow = Math.ceil((w * 4) / 256) * 256;

    if (!this.rbTexture || !this.rbBuffer || this.rbSize.w !== w || this.rbSize.h !== h) {
      this.rbTexture?.destroy();
      this.rbBuffer?.destroy();
      this.rbTexture = this.device.createTexture({
        label: 'readback-target',
        size: [w, h, 1],
        format: this.gpu.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this.rbBuffer = this.device.createBuffer({
        size: bytesPerRow * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.rbSize = { w, h, bytesPerRow };
    }

    this.encode(this.rbTexture!.createView());

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.rbTexture! },
      { buffer: this.rbBuffer!, bytesPerRow, rowsPerImage: h },
      [w, h, 1],
    );
    this.device.queue.submit([enc.finish()]);

    await this.rbBuffer!.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(this.rbBuffer!.getMappedRange());
    const rgba = new Uint8ClampedArray(w * h * 4);
    const bgra = this.gpu.format.startsWith('bgra');
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * bytesPerRow + x * 4;
        const o = (y * w + x) * 4;
        if (bgra) {
          rgba[o] = src[i + 2];
          rgba[o + 1] = src[i + 1];
          rgba[o + 2] = src[i];
        } else {
          rgba[o] = src[i];
          rgba[o + 1] = src[i + 1];
          rgba[o + 2] = src[i + 2];
        }
        rgba[o + 3] = 255;
      }
    }
    this.rbBuffer!.unmap();
    return { width: w, height: h, rgba };
  }
}
