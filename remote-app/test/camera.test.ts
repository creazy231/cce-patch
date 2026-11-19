import { describe, expect, test } from "bun:test";
import { startCamera } from "../src/components/camera";

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  get off() {
    return this.tracks.every((t) => t.stopped);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("startCamera", () => {
  test("gives the stream and the decoder once both are there; the camera stays on until close()", async () => {
    const stream = new FakeStream();
    const session = startCamera(async () => stream, async () => "decoder");
    const ready = await session.ready;
    expect(ready).toEqual({ stream, decoder: "decoder" });
    expect(stream.off).toBe(false);
    session.close();
    expect(stream.off).toBe(true);
  });

  test("the decoder fails after the camera came on: the camera goes off again", async () => {
    const stream = new FakeStream();
    const decoder = deferred<string>();
    const session = startCamera(async () => stream, () => decoder.promise);
    await settle();
    decoder.reject(new Error("chunk failed to load"));
    await expect(session.ready).rejects.toThrow("chunk failed to load");
    expect(stream.off).toBe(true);
  });

  test("the decoder fails before the camera comes on: the camera is turned off the moment it does", async () => {
    const stream = new FakeStream();
    const camera = deferred<FakeStream>();
    const session = startCamera(() => camera.promise, async () => {
      throw new Error("chunk failed to load");
    });
    await expect(session.ready).rejects.toThrow("chunk failed to load");
    camera.resolve(stream);
    await settle();
    expect(stream.off).toBe(true);
  });

  test("closed before the camera comes on: it is turned off the moment it does", async () => {
    const stream = new FakeStream();
    const camera = deferred<FakeStream>();
    const session = startCamera(() => camera.promise, async () => "decoder");
    session.ready.catch(() => undefined);
    session.close();
    camera.resolve(stream);
    await settle();
    expect(stream.off).toBe(true);
  });

  test("the camera is refused: ready rejects with that error and nothing is left on", async () => {
    const refused = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const session = startCamera(
      async (): Promise<FakeStream> => {
        throw refused;
      },
      async () => "decoder",
    );
    await expect(session.ready).rejects.toBe(refused);
    session.close();
  });
});
