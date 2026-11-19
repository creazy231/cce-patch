/** Longest side of an attached photo after downscaling. */
export const MAX_SIDE = 1568;
const JPEG_QUALITY = 0.85;

/** The size an image of w x h gets when its longest side is limited to `max` (never enlarged, never below 1 px). */
export function fitWithin(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w, h };
  const longest = Math.max(w, h);
  if (longest <= max) return { w, h };
  const scale = max / longest;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/**
 * Decodes the photo. Browsers apply the EXIF rotation by themselves (so a portrait photo is not
 * drawn sideways); `imageOrientation: "from-image"` is not passed because older Safari rejects it.
 */
async function decode(file: Blob): Promise<{ source: CanvasImageSource; w: number; h: number; release: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, w: bitmap.width, h: bitmap.height, release: () => bitmap.close() };
    } catch {
      // fall through to an <img> element
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Shrinks a photo for sending: longest side at most 1568 px, re-encoded as JPEG (quality 0.85).
 * `data` is base64 without the data: prefix, as the phone protocol wants it.
 */
export async function downscaleImage(file: Blob): Promise<{ mediaType: "image/jpeg"; data: string }> {
  const image = await decode(file);
  try {
    const { w, h } = fitWithin(image.w, image.h);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the image");
    // JPEG has no transparency: a transparent PNG would turn black without a background.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, w, h);
    context.drawImage(image.source, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) throw new Error("Could not encode the image");
    return { mediaType: "image/jpeg", data: await toBase64(blob) };
  } finally {
    image.release();
  }
}
