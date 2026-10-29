import { describe, expect, it, vi } from 'vitest';
import type { NativeImage } from 'electron';
import { createProjectionImageDecoder } from './projection-image';

const frame = { sequence: 1, width: 2, height: 2, mime: 'image/png' as const, data: 'YQ==' };
const signal = new AbortController().signal;
const image = (pixels: number[], size = { width: 2, height: 2 }) => ({
  isEmpty: () => false, getSize: () => size, toBitmap: () => Buffer.from(pixels), resize: vi.fn(),
}) as unknown as NativeImage;

describe('native image → host video pixels', () => {
  it.each(['BGRA', 'RGBA', 'ARGB'])('converts %s without assuming native byte order or alpha representation', async order => {
    for (const premultiplied of [true, false]) {
      const pixel = (alpha: number) => {
        const factor = premultiplied ? alpha / 255 : 1;
        const values = { B: Math.round(40 * factor), G: Math.round(100 * factor), R: Math.round(200 * factor), A: alpha };
        return [...order].map(c => values[c as keyof typeof values]);
      };
      const probe = [...pixel(255), ...pixel(128)];
      const read = vi.fn().mockReturnValueOnce(image(probe)).mockReturnValue(image([...probe, ...probe]));
      const decode = createProjectionImageDecoder(read, { r: 10, g: 20, b: 30 });
      const output = await decode(Object.freeze({ ...frame }), signal);
      expect([...output.subarray(0, 4)]).toEqual([40, 100, 200, 255]);
      for (const [i, expected] of [35, 60, 105].entries()) expect(Math.abs(output[4 + i]! - expected)).toBeLessThanOrEqual(1);
      expect(output[7]).toBe(255);
      expect(frame.data).toBe('YQ==');
      await decode(frame, signal); expect(read).toHaveBeenCalledTimes(3); // format probed once
    }
  });

  it('resizes only the video representation to the declared input coordinate space', async () => {
    const source = image([], { width: 4, height: 4 });
    vi.mocked(source.resize).mockReturnValue(image(Array(16).fill(255)));
    const read = vi.fn().mockReturnValueOnce(image([40, 100, 200, 255, 20, 50, 100, 128])).mockReturnValue(source);
    const decode = createProjectionImageDecoder(read, { r: 0, g: 0, b: 0 });
    expect((await decode(frame, signal)).length).toBe(16);
    expect(source.resize).toHaveBeenCalledWith({ width: 2, height: 2, quality: 'good' });
  });

  it('refuses cancelled, oversized, undecodable and unsupported pixel data', async () => {
    const probe = image([40, 100, 200, 255, 20, 50, 100, 128]);
    const read = vi.fn().mockReturnValueOnce(probe).mockReturnValue(image([]));
    const decode = createProjectionImageDecoder(read, { r: 0, g: 0, b: 0 });
    const aborted = new AbortController(); aborted.abort(new Error('App revoked'));
    await expect(decode(frame, aborted.signal)).rejects.toThrow('App revoked');
    await expect(decode({ ...frame, width: 8192 }, signal)).rejects.toThrow(/pixel limit/);
    expect(read).not.toHaveBeenCalled();
    await expect(decode(frame, signal)).rejects.toThrow(/pixel dimensions/);
    const empty = createProjectionImageDecoder(() => ({ isEmpty: () => true }) as NativeImage, { r: 0, g: 0, b: 0 });
    await expect(empty(frame, signal)).rejects.toThrow(/decoder is unavailable/);
    const invalid = createProjectionImageDecoder(() => image([0, 0, 0, 0, 0, 0, 0, 0]), { r: 0, g: 0, b: 0 });
    await expect(invalid(frame, signal)).rejects.toThrow(/channel layout/);
    expect(() => createProjectionImageDecoder(read, { r: -1, g: 0, b: 0 })).toThrow(/background/);
  });
});
