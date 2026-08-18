// Minimal typings for mp4box (the npm package ships none).
declare module 'mp4box' {
  export interface MP4VideoTrack {
    id: number;
    codec: string;
    timescale: number;
    video: { width: number; height: number };
  }
  export interface MP4Info {
    videoTracks: MP4VideoTrack[];
    audioTracks: unknown[];
  }
  export interface MP4Sample {
    data: Uint8Array;
    is_sync: boolean;
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
  }
  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onError?: (e: string) => void;
    onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void;
    appendBuffer(data: ArrayBuffer & { fileStart: number }): number;
    start(): void;
    stop(): void;
    flush(): void;
    setExtractionOptions(id: number, user: unknown, opts: { nbSamples?: number }): void;
    getTrackById(id: number): any;
  }
  export function createFile(): MP4File;
  export class DataStream {
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean);
    static BIG_ENDIAN: boolean;
    buffer: ArrayBuffer;
  }
  const MP4Box: { createFile: typeof createFile; DataStream: typeof DataStream };
  export default MP4Box;
}
