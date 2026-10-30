import type { NativeImage } from 'electron';
import type { ProjectionFrame } from '@shared/extensions/projection-protocol';

type ReadImage = (bytes: Buffer) => NativeImage;
type Matte = Readonly<{ r: number; g: number; b: number }>;
export type ProjectionPixelLease = Readonly<{ data: Uint8Array; release(): void }>;
// Two known sRGB pixels: opaque and half-transparent RGBA(200,100,40).
const pixelProbe = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4nGM4kaLxH4gbABQMBChdYZXzAAAAAElFTkSuQmCC';

/** One host decoder per video feed. The caller chooses the opaque video matte. */
export function createProjectionImageDecoder(read: ReadImage, matte: Matte) {
  if (![matte.r, matte.g, matte.b].every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
    throw new Error('Invalid projection video background');
  }
  let layout: { channels: number[]; alpha: number; premultiplied: boolean } | undefined;
  let storage = new Uint8Array(0), leased = false;
  const format = () => {
    if (layout) return layout;
    const image = read(Buffer.from(pixelProbe, 'base64'));
    if (image.isEmpty()) throw new Error('Native projection image decoder is unavailable');
    const pixels = image.toBitmap({ scaleFactor: 1 });
    if (pixels.length !== 8) throw new Error('Unsupported native projection pixel size');
    const first = [...pixels.subarray(0, 4)];
    const channels = [40, 100, 200].map(value => first.indexOf(value)); // B,G,R
    const alpha = first.indexOf(255);
    if (new Set([...channels, alpha]).size !== 4 || channels.includes(-1) || alpha < 0 || pixels[4 + alpha] !== 128) {
      throw new Error('Unsupported native projection channel layout');
    }
    const matches = (premultiplied: boolean) => channels.every((channel, index) =>
      Math.abs(pixels[4 + channel]! - [40, 100, 200][index]! * (premultiplied ? 128 / 255 : 1)) <= 1);
    const premultiplied = matches(true);
    if (!premultiplied && !matches(false)) throw new Error('Unsupported native projection alpha format');
    layout = { channels, alpha, premultiplied };
    return layout;
  };
  return async (frame: Readonly<ProjectionFrame>, signal: AbortSignal): Promise<ProjectionPixelLease> => {
    signal.throwIfAborted();
    if (leased) throw new Error('Projection video pixels are still leased');
    if (![frame.width, frame.height].every(v => Number.isSafeInteger(v) && v >= 2 && v <= 2560)
      || frame.width * frame.height > 921600) throw new Error('Projection image exceeds the video pixel limit');
    const { channels, alpha, premultiplied } = format();
    const image = read(Buffer.from(frame.data, 'base64'));
    if (image.isEmpty()) throw new Error('Projection source image could not be decoded');
    const size = image.getSize(1);
    if (!size.width || !size.height || size.width > 8192 || size.height > 8192 || size.width * size.height > 16777216) {
      throw new Error('Projection source image is too large');
    }
    // This is the video coordinate space, not an attachment/model resize policy.
    // Keep the stored/source image and its identity untouched.
    const target = size.width === frame.width && size.height === frame.height ? image
      : image.resize({ width: frame.width, height: frame.height, quality: 'good' });
    const pixels = target.toBitmap({ scaleFactor: 1 });
    signal.throwIfAborted();
    if (pixels.length !== frame.width * frame.height * 4) throw new Error('Projection image has unexpected pixel dimensions');
    // NativeImage.toBitmap still makes its own copy; reuse the normalized video
    // storage only after the encoder has returned the previous borrow.
    if (storage.length !== pixels.length) storage = new Uint8Array(pixels.length);
    const bgra = storage;
    const background = [matte.b, matte.g, matte.r];
    for (let at = 0; at < pixels.length; at += 4) {
      const opacity = pixels[at + alpha]! / 255;
      for (let channel = 0; channel < 3; channel++) {
        const color = pixels[at + channels[channel]!]! * (premultiplied ? 1 : opacity);
        bgra[at + channel] = Math.min(255, Math.round(color + background[channel]! * (1 - opacity)));
      }
      bgra[at + 3] = 255;
    }
    leased = true;
    let returned = false;
    return Object.freeze({ data: bgra, release() {
      if (returned) return;
      returned = true;
      leased = false;
    } });
  };
}
