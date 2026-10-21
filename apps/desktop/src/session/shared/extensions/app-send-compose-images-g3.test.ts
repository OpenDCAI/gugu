import { describe, expect, it } from 'vitest';
import { APP_COMPOSE_IMAGE_MAX_BYTES, APP_COMPOSE_MAX_IMAGES } from './app-runtime-protocol';
import { composeImagesOf } from './app-send-core';

/**
 * G3: `gugu.compose(text, { …, images })` — an App's "cite this" can carry a crop of what was picked, put beside the
 * text as attachments of the chat's draft; nothing is sent. The one check, for the desktop's main and the phone's page.
 */
const png = (bytes = 4) => ({ name: 'crop.png', type: 'image/png', bytes: new ArrayBuffer(bytes) });

describe('composeImagesOf (G3)', () => {
  it('none given: no images; images given: each kept as it came, a missing name made from its type', () => {
    expect(composeImagesOf(undefined)).toEqual([]);
    const [named, unnamed] = composeImagesOf([png(), { name: '', type: 'image/webp', bytes: new ArrayBuffer(1) }]);
    expect(named).toMatchObject({ name: 'crop.png', type: 'image/png' });
    expect(unnamed).toMatchObject({ name: 'image-2.webp', type: 'image/webp' });
  });

  it('refused, said which and why: not a list, not an image, too many, too large', () => {
    expect(() => composeImagesOf(png())).toThrow(/images is a list/);
    expect(() => composeImagesOf([{ name: 'a.pdf', type: 'application/pdf', bytes: new ArrayBuffer(1) }])).toThrow(/images\[0\] is not an image/);
    expect(() => composeImagesOf([{ name: 'a.png', type: 'image/png', bytes: 'AAAA' }])).toThrow(/images\[0\] is not an image/);
    expect(() => composeImagesOf(Array.from({ length: APP_COMPOSE_MAX_IMAGES + 1 }, () => png()))).toThrow(/At most 9 images/);
    expect(() => composeImagesOf([png(APP_COMPOSE_IMAGE_MAX_BYTES + 1)])).toThrow(/images\[0\] is over the 10 MiB/);
    // Control: exactly at the limits it is fine.
    expect(composeImagesOf([...Array.from({ length: APP_COMPOSE_MAX_IMAGES - 1 }, () => png()), png(APP_COMPOSE_IMAGE_MAX_BYTES)])).toHaveLength(9);
  });
});
