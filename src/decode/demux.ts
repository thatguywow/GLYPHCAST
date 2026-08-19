import MP4Box from 'mp4box';
import type { VideoConfig } from '../types';

/**
 * Demuxes an MP4 File into a VideoConfig + a stream of EncodedVideoChunks
 * (in decode order). WebCodecs cannot demux, so mp4box does it here.
 */
export function demuxFile(
  file: File,
  onConfig: (cfg: VideoConfig) => void,
  onChunk: (chunk: EncodedVideoChunk) => void,
  onError: (e: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const mp4 = MP4Box.createFile();

    mp4.onError = (e) => onError(e);

    mp4.onReady = (info) => {
      const track = info.videoTracks[0];
      if (!track) {
        onError('No video track found in this file.');
        resolve();
        return;
      }
      onConfig({
        codec: track.codec,
        codedWidth: track.video.width,
        codedHeight: track.video.height,
        description: buildDescription(mp4, track.id),
      });
      mp4.setExtractionOptions(track.id, null, { nbSamples: 1_000_000 });
      mp4.start();
    };

    mp4.onSamples = (_id, _user, samples) => {
      for (const s of samples) {
        onChunk(
          new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: (1e6 * s.cts) / s.timescale,
            duration: (1e6 * s.duration) / s.timescale,
            data: s.data,
          }),
        );
      }
    };

    file
      .arrayBuffer()
      .then((raw) => {
        const buf = raw as ArrayBuffer & { fileStart: number };
        buf.fileStart = 0;
        mp4.appendBuffer(buf);
        mp4.flush();
        resolve();
      })
      .catch((err) => {
        onError(String(err));
        resolve();
      });
  });
}

/** Extracts the codec-specific description (avcC/hvcC/...) minus the 8-byte box header. */
function buildDescription(mp4: ReturnType<typeof MP4Box.createFile>, trackId: number): Uint8Array | undefined {
  const trak = mp4.getTrackById(trackId);
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? [];
  for (const entry of entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
  }
  return undefined;
}

/**
 * Extracts the source's audio track as a self-contained fragmented MP4.
 *
 * mp4box's segmentation is used rather than hand-muxing: it emits a proper
 * initialisation segment followed by media segments, and concatenating them
 * yields a file an <audio> element can play directly. Returns null when the
 * source has no audio, which is not an error — plenty of clips do not.
 */
export function extractAudio(file: File): Promise<{ mime: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const mp4 = MP4Box.createFile();
    const parts: ArrayBuffer[] = [];
    let failed = false;

    mp4.onError = () => {
      failed = true;
      resolve(null);
    };

    mp4.onReady = (info) => {
      const track = info.audioTracks?.[0];
      if (!track) {
        resolve(null);
        return;
      }
      try {
        mp4.setSegmentOptions(track.id, null, { nbSamples: 1_000_000 });
        for (const seg of mp4.initializeSegmentation()) parts.push(seg.buffer);
        mp4.start();
      } catch {
        failed = true;
        resolve(null);
      }
    };

    mp4.onSegment = (_id, _user, buffer) => {
      parts.push(buffer);
    };

    file
      .arrayBuffer()
      .then((raw) => {
        const buf = raw as ArrayBuffer & { fileStart: number };
        buf.fileStart = 0;
        mp4.appendBuffer(buf);
        mp4.flush();
        if (failed) return;
        if (parts.length === 0) {
          resolve(null);
          return;
        }
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const bytes = new Uint8Array(total);
        let o = 0;
        for (const p of parts) {
          bytes.set(new Uint8Array(p), o);
          o += p.byteLength;
        }
        resolve({ mime: 'audio/mp4', bytes });
      })
      .catch(() => resolve(null));
  });
}
