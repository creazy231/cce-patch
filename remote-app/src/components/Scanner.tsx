// Full-screen QR scanner: the back camera, decoded with jsQR (loaded only when scanning).

import { useEffect, useRef, useState } from "preact/hooks";
import { startCamera } from "./camera";
import { Close } from "./icons";

const SCAN_EVERY_MS = 140;
const SCAN_SIDE = 720;

function cameraError(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera access is off for CCE Remote. Allow it in the iPhone's Settings, or paste the link instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found. Paste the link or type the code instead.";
  if (name === "NotReadableError") return "The camera is busy in another app.";
  if (name === "ChunkLoadError" || /import|module/i.test(String((error as Error)?.message ?? "")))
    return "Couldn't load the scanner. Reload the app and try again.";
  return "The camera isn't available here. Paste the link or type the code instead.";
}

export interface ScannerProps {
  /** Return true when the text was a pairing (scanning stops), false to keep scanning. */
  onResult: (text: string) => boolean;
  onClose: () => void;
}

export function Scanner({ onResult, onClose }: ScannerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const result = useRef(onResult);
  result.current = onResult;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastWrong = "";
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setError(cameraError(Object.assign(new Error("no camera API"), { name: "NotFoundError" })));
      return;
    }
    // The camera and the decoder start together; whatever fails, a camera that came on is turned off again.
    const camera = startCamera(
      () => media.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }),
      () => import("jsqr").then((module) => module.default),
    );

    const run = async () => {
      const { stream, decoder: jsQR } = await camera.ready;
      const el = video.current;
      if (stopped || !el) return;
      el.srcObject = stream;
      await el.play();
      setLive(true);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("no canvas");
      const tick = () => {
        if (stopped) return;
        if (el.readyState >= 2 && el.videoWidth > 0) {
          const scale = Math.min(1, SCAN_SIDE / Math.max(el.videoWidth, el.videoHeight));
          const w = Math.round(el.videoWidth * scale);
          const h = Math.round(el.videoHeight * scale);
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          context.drawImage(el, 0, 0, w, h);
          const found = jsQR(context.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
          if (found?.data) {
            if (result.current(found.data)) return;
            if (found.data !== lastWrong) {
              lastWrong = found.data;
              setHint("That QR code isn't a CCE Remote pairing code.");
            }
          }
        }
        timer = setTimeout(tick, SCAN_EVERY_MS);
      };
      tick();
    };
    run().catch((e: unknown) => {
      camera.close(); // nothing scans any more: the camera goes off
      if (!stopped) setError(cameraError(e));
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      camera.close();
    };
  }, []);

  return (
    <div class="scanner" role="dialog" aria-modal="true" aria-label="Scan the QR code">
      <video ref={video} class={live ? "live" : ""} playsInline muted autoplay />
      <div class="scanner-shade" aria-hidden="true">
        <div class="scanner-frame">
          <span class="corner tl" />
          <span class="corner tr" />
          <span class="corner bl" />
          <span class="corner br" />
        </div>
      </div>
      <button type="button" class="scanner-close" onClick={onClose} aria-label="Close the scanner">
        <Close size={22} stroke={2.2} />
      </button>
      <div class="scanner-text" role="status">
        {error ? (
          <p class="scanner-error">{error}</p>
        ) : (
          <>
            <p>Point the camera at the QR code in the Connection tab.</p>
            {hint && <p class="scanner-hint">{hint}</p>}
          </>
        )}
      </div>
    </div>
  );
}
