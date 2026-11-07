import { describe, expect, it } from 'vitest';
import { itemScrollTarget } from './scroll-to-item';

describe('source positioning with a pinned question', () => {
 const input = { rowTop: 900, rowHeight: 200, viewportHeight: 600, topInset: 108, offset: 0 };
 it('keeps start-aligned source content below the pinned question', () => {
  expect(itemScrollTarget({ ...input, align: 'start' })).toBe(792);
  expect(itemScrollTarget({ ...input, topInset: 0, align: 'start' })).toBe(900);
 });
 it('keeps center and end alignment relative to the readable viewport', () => {
  expect(itemScrollTarget({ ...input, align: 'center' })).toBe(646);
  expect(itemScrollTarget({ ...input, align: 'end' })).toBe(500);
  expect(itemScrollTarget({ ...input, rowHeight: 900, align: 'center' })).toBe(792);
 });
 it('preserves explicit offsets and clamps before the document start', () => {
  expect(itemScrollTarget({ ...input, align: 'start', offset: 20 })).toBe(812);
  expect(itemScrollTarget({ ...input, rowTop: 30, align: 'start' })).toBe(0);
 });
});
