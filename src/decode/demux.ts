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
