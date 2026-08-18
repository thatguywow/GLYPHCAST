import type { VideoConfig } from '../types';

/** Thin wrapper over the WebCodecs VideoDecoder. */
export class Decoder {
  private decoder: VideoDecoder;

  constructor(onFrame: (f: VideoFrame) => void, onError: (e: string) => void) {
    this.decoder = new VideoDecoder({
      output: onFrame,
      error: (e) => onError(e.message),
    });
  }

  static async isSupported(cfg: VideoConfig): Promise<boolean> {
    try {
      const res = await VideoDecoder.isConfigSupported({
        codec: cfg.codec,
        codedWidth: cfg.codedWidth,
        codedHeight: cfg.codedHeight,
        description: cfg.description,
      });
      return !!res.supported;
    } catch {
      return false;
    }
  }

  configure(cfg: VideoConfig) {
    this.decoder.configure({
      codec: cfg.codec,
      codedWidth: cfg.codedWidth,
      codedHeight: cfg.codedHeight,
      description: cfg.description,
      optimizeForLatency: true,
    });
  }

  decode(chunk: EncodedVideoChunk) {
    this.decoder.decode(chunk);
  }

  get queueSize(): number {
    return this.decoder.decodeQueueSize;
  }

  get state(): CodecState {
    return this.decoder.state;
  }

  async flush() {
    if (this.decoder.state === 'configured') await this.decoder.flush();
  }

  close() {
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}
