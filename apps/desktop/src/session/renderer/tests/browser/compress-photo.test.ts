/** 手机「照片」默认发压缩图:长边 ≤ 2048 的 JPEG;本来就小的、动图原样发。真浏览器里解码 / 编码。 */
import { expect, it } from 'vitest';
import { compressPhoto } from '@/components/chat/compressPhoto';

async function png(width: number, height: number, name = 'shot.png') {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  // Noise, so the PNG is big the way a camera photo is.
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < image.data.length; i += 1) image.data[i] = (i * 2654435761) >>> 24;
  ctx.putImageData(image, 0, 0);
  return new File([await canvas.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' });
}

it('shrinks a big photo to a JPEG whose long edge is 2048', async () => {
  const big = await png(4000, 3000);
  const out = await compressPhoto(big);
  expect(out.type).toBe('image/jpeg');
  expect(out.name).toBe('shot.jpg');
  expect(out.size).toBeLessThan(big.size);
  const bitmap = await createImageBitmap(out);
  expect([bitmap.width, bitmap.height]).toEqual([2048, 1536]);
});

it('keeps a small image and a GIF as they are', async () => {
  const small = await png(64, 64);
  expect(await compressPhoto(small)).toBe(small);
  const gif = new File([new Uint8Array(600_000)], 'a.gif', { type: 'image/gif' });
  expect(await compressPhoto(gif)).toBe(gif);
});
