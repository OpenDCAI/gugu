import { afterEach, expect, it, vi } from 'vitest';
import { compressScreenshot, registerPastedScreenshot, selectedScreenshot, screenshotQuality, toggleScreenshotQuality } from '@/lib/pastedScreenshot';

afterEach(() => vi.unstubAllGlobals());
function codec(sizes = [200_000]) {
  const close = vi.fn(), drawImage = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3840, height: 2100, close })));
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob: vi.fn((done: (blob: Blob) => void) => done(new Blob([new Uint8Array(sizes.shift() ?? 200_000)], { type: 'image/webp' }))) };
  vi.stubGlobal('document', { createElement: () => canvas });
  return { canvas, close };
}
it('resizes without cropping, emits a real matching WebP name and caches bytes across retries and quality switches', async () => {
  const { canvas, close } = codec();
  const original = new File([new Uint8Array(1_200_000)], 'screen.png', { type: 'image/png' });
  registerPastedScreenshot(original);
  const compressed = await selectedScreenshot(original);
  expect([canvas.width, canvas.height]).toEqual([2000, 1094]);
  expect(compressed).toMatchObject({ name: 'screen.webp', type: 'image/webp', size: 200_000 });
  expect(await selectedScreenshot(original)).toBe(compressed);
  toggleScreenshotQuality(original);
  expect(screenshotQuality(original)).toBe('original');
  expect(await selectedScreenshot(original)).toBe(original);
  toggleScreenshotQuality(original);
  expect(await selectedScreenshot(original)).toBe(compressed);
  expect(close).toHaveBeenCalledOnce();
});
it('tries bounded quality levels if the initial WebP exceeds the target and never processes unregistered files', async () => {
  const { canvas } = codec([500_000, 400_000, 250_000]);
  const original = new File([new Uint8Array(1_200_000)], 'screen.png', { type: 'image/png' });
  expect(await selectedScreenshot(original)).toBe(original);
  const encoded = await compressScreenshot(original);
  expect(encoded.size).toBeLessThanOrEqual(300 * 1024);
  expect(canvas.width).toBe(2000);
  expect(canvas.toBlob).toHaveBeenCalledTimes(3);
});
it('does not opt animated formats in and exposes conversion failure instead of silently sending an original', async () => {
  const gif = new File(['gif'], 'animation.gif', { type: 'image/gif' });
  registerPastedScreenshot(gif);
  expect(screenshotQuality(gif)).toBeUndefined();
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode')));
  const png = new File(['broken'], 'screen.png', { type: 'image/png' });
  registerPastedScreenshot(png);
  await expect(selectedScreenshot(png)).rejects.toMatchObject({ code: 'screenshot_processing_failed' });
  toggleScreenshotQuality(png);
  expect(await selectedScreenshot(png)).toBe(png);
});
