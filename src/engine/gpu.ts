export interface GPUContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
}

export async function initGPU(canvas: HTMLCanvasElement): Promise<GPUContext> {
  if (!('gpu' in navigator)) {
    throw new Error('WebGPU not supported. Use Chrome/Edge 113+, or Safari 18+ / Firefox with WebGPU enabled.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No suitable GPU adapter found.');

  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    console.error('WebGPU device lost:', info.message);
  });

  const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!context) throw new Error('Failed to acquire WebGPU canvas context.');

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { device, context, format, canvas };
}
