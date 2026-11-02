export const SCREENSHOT_MAX_EDGE = 2000;
export const SCREENSHOT_TARGET_BYTES = 300 * 1024;
export type ScreenshotQuality = 'compressed' | 'original';
type Screenshot = { quality: ScreenshotQuality; compressed?: Promise<File>; failed?: boolean };
const screenshots = new WeakMap<File, Screenshot>();
const previews = new WeakMap<File, Promise<string>>();
export function screenshotPreview(file: File): Promise<string> {
  let preview = previews.get(file);
  if (!preview) {
    preview = file.arrayBuffer().then(bytes => {
      let binary = '';
      for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
      return `data:${file.type};base64,${btoa(binary)}`;
    });
    previews.set(file, preview);
  }
  return preview;
}

/** Only clipboard PNG/JPEG screenshots opt in; picked files and animated images keep their bytes. */
export function registerPastedScreenshot(file: File): void {
  if (/^image\/(png|jpeg)$/i.test(file.type) && !screenshots.has(file)) screenshots.set(file, { quality: 'compressed' });
}
export const screenshotQuality = (file: File): ScreenshotQuality | undefined => screenshots.get(file)?.quality;
export function toggleScreenshotQuality(file: File): void {
  const image = screenshots.get(file);
  if (image) image.quality = image.quality === 'compressed' ? 'original' : 'compressed';
}
export function retryScreenshot(file: File): void {
  const image = screenshots.get(file);
  if (image?.failed) { image.compressed = undefined; image.failed = false; }
}

/** Kept on the source File so draft hand-off and ordinary retries reuse the exact encoded bytes. */
export function selectedScreenshot(file: File): Promise<File> {
  const image = screenshots.get(file);
  if (!image || image.quality === 'original') return Promise.resolve(file);
  return image.compressed ??= compressScreenshot(file).catch(error => {
    image.failed = true;
    throw Object.assign(new Error('Screenshot conversion failed', { cause: error }), { code: 'screenshot_processing_failed' });
  });
}

export async function compressScreenshot(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('Empty screenshot');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image conversion is unavailable');
    const scale = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    let encoded: Blob | null = null;
    for (const quality of [0.85, 0.78, 0.72]) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      encoded = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
        if (blob?.type === 'image/webp') resolve(blob);
        else reject(new Error('WebP encoding is unavailable'));
      }, 'image/webp', quality));
      if (encoded.size <= SCREENSHOT_TARGET_BYTES) break;
    }
    if (!encoded) throw new Error('Screenshot conversion produced no image');
    // A small original is preferable to a larger WebP, but oversized originals still need resizing.
    if (Math.max(bitmap.width, bitmap.height) <= SCREENSHOT_MAX_EDGE && file.size <= encoded.size) return file;
    return new File([encoded], `${(file.name || 'screenshot').replace(/\.[^.]+$/, '')}.webp`, { type: 'image/webp', lastModified: file.lastModified });
  } finally { bitmap.close(); }
}
