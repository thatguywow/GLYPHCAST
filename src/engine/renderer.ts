import type { GPUContext } from './gpu';
import type { GlyphAtlas } from './glyphAtlas';
import type { RenderParams } from '../types';
import downsampleWGSL from './shaders/downsample.wgsl?raw';
import asciiWGSL from './shaders/ascii.wgsl?raw';

export class Renderer {
  private device: GPUDevice;
  private computePipeline: GPUComputePipeline;
  private renderPipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private dUniform: GPUBuffer;
  private rUniform: GPUBuffer;

  private videoTex: GPUTexture | null = null;
  private cellTex: GPUTexture | null = null;
  private computeBG: GPUBindGroup | null = null;
  private renderBG: GPUBindGroup | null = null;

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
      compute: {
        module: dev.createShaderModule({ code: downsampleWGSL }),
        entryPoint: 'main',
      },
    });

    const asciiModule = dev.createShaderModule({ code: asciiWGSL });
    this.renderPipeline = dev.createRenderPipeline({
      layout: 'auto',
      vertex: { module: asciiModule, entryPoint: 'vs' },
      fragment: {
        module: asciiModule,
        entryPoint: 'fs',
        targets: [{ format: gpu.format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.sampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.dUniform = dev.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.rUniform = dev.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Sets the source video dimensions and (re)builds the grid + GPU resources. */
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
    this.rebuildGrid();
  }

  setParams(p: RenderParams) {
    this.params = p;
    this.rebuildGrid();
  }

  get outputSize(): [number, number] {
    return [this.gpu.canvas.width, this.gpu.canvas.height];
  }

  private rebuildGrid() {
    if (!this.videoTex || this.videoW === 0) return;

    const cols = Math.max(8, Math.floor(this.params.cols));
    const rows = Math.max(1, Math.round(cols * (this.videoH / this.videoW)));
    this.gridW = cols;
    this.gridH = rows;

    // One glyph tile maps to a cellPx x cellPx block of output pixels.
    this.gpu.canvas.width = cols * this.params.cellPx;
    this.gpu.canvas.height = rows * this.params.cellPx;

    this.cellTex?.destroy();
    this.cellTex = this.device.createTexture({
      label: 'cell-buffer',
      size: [cols, rows, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    // Downsample uniforms (8 x u32).
    const d = new Uint32Array([cols, rows, 0, 0, this.videoW, this.videoH, 0, 0]);
    this.device.queue.writeBuffer(this.dUniform, 0, d);

    // Render uniforms (48 bytes, mixed u32/f32).
    const buf = new ArrayBuffer(48);
    const dv = new DataView(buf);
    dv.setUint32(0, cols, true);
    dv.setUint32(4, rows, true);
    dv.setUint32(8, this.atlas.glyphCount, true);
    dv.setUint32(12, this.atlas.rampLen, true);
    dv.setFloat32(16, this.params.edgeThreshold, true);
    dv.setUint32(20, this.params.edgeEnable ? 1 : 0, true);
    dv.setUint32(24, this.params.colorMode, true);
    dv.setUint32(28, 0, true);
    dv.setFloat32(32, this.params.tint[0], true);
    dv.setFloat32(36, this.params.tint[1], true);
    dv.setFloat32(40, this.params.tint[2], true);
    dv.setFloat32(44, 0, true);
    this.device.queue.writeBuffer(this.rUniform, 0, buf);

    this.computeBG = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.videoTex.createView() },
        { binding: 1, resource: this.cellTex.createView() },
        { binding: 2, resource: { buffer: this.dUniform } },
      ],
    });
    this.renderBG = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.cellTex.createView() },
        { binding: 1, resource: this.atlas.texture.createView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.rUniform } },
      ],
    });
  }

  /**
   * Renders one frame from any external image source (a decoded VideoFrame, or a
   * 2D canvas / ImageBitmap for the demo generator). With no source, re-renders
   * the last-uploaded frame (used for live param changes while paused).
   */
  render(
    source?: VideoFrame | HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
    srcW = 0,
    srcH = 0,
  ) {
    if (source) {
      const anySrc = source as { displayWidth?: number; width?: number; displayHeight?: number; height?: number };
      const w = srcW || anySrc.displayWidth || anySrc.width || 0;
      const h = srcH || anySrc.displayHeight || anySrc.height || 0;
      this.setSource(w, h);
      this.device.queue.copyExternalImageToTexture(
        { source: source as any },
        { texture: this.videoTex! },
        [w, h],
      );
    }

    if (!this.videoTex || !this.cellTex || !this.computeBG || !this.renderBG) return;

    const enc = this.device.createCommandEncoder();

    const cp = enc.beginComputePass();
    cp.setPipeline(this.computePipeline);
    cp.setBindGroup(0, this.computeBG);
    cp.dispatchWorkgroups(Math.ceil(this.gridW / 8), Math.ceil(this.gridH / 8), 1);
    cp.end();

    const view = this.gpu.context.getCurrentTexture().createView();
    const rp = enc.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    rp.setPipeline(this.renderPipeline);
    rp.setBindGroup(0, this.renderBG);
    rp.draw(3);
    rp.end();

    this.device.queue.submit([enc.finish()]);
  }
}
