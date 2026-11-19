// The scanner's camera and QR decoder, started together. Whatever happens — the scanner closes, the decoder
// chunk fails to load (an old page after a deploy), the camera comes on late — a camera that was turned on
// is turned off again.

export interface TrackLike {
  stop(): void;
}

export interface StreamLike {
  getTracks(): TrackLike[];
}

export interface CameraSession<S, D> {
  /** The stream and the decoder once both are there. Rejects if either fails; the camera is off again then. */
  ready: Promise<{ stream: S; decoder: D }>;
  /** Turns the camera off now, or the moment it comes on. */
  close(): void;
}

const turnOff = (stream: StreamLike) => {
  for (const track of stream.getTracks()) track.stop();
};

export function startCamera<S extends StreamLike, D>(openCamera: () => Promise<S>, loadDecoder: () => Promise<D>): CameraSession<S, D> {
  let wanted = true;
  let stream: S | null = null;
  const close = () => {
    wanted = false;
    if (stream) turnOff(stream);
    stream = null;
  };
  const camera = openCamera().then((media) => {
    if (!wanted) {
      turnOff(media);
      throw new Error("the scanner was closed");
    }
    stream = media;
    return media;
  });
  const ready = Promise.all([camera, loadDecoder()]).then(
    ([media, decoder]) => ({ stream: media, decoder }),
    (error: unknown) => {
      close();
      throw error;
    },
  );
  return { ready, close };
}
