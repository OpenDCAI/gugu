import { expect, it } from 'vitest';
import { taskPageViewport } from './task-page-viewport';
it('clips negative and oversized guest rectangles to the trusted App viewport', () => {
  expect(taskPageViewport({ visible: true, x: 100, y: 200, width: 300, height: 200 },
    { x: -1000, y: -1000, width: 3000, height: 3000 }, 1)).toEqual({ x: 100, y: 200, width: 300, height: 200 });
});
it('respects host clipping and guest zoom without drawing over other host content', () => {
  const metrics = { visible: true, x: -50, y: 200, width: 400, height: 300, clip: { x: 0, y: 220, width: 200, height: 100 } };
  expect(taskPageViewport(metrics, { x: 20, y: 0, width: 200, height: 200 }, 2)).toEqual({ x: 0, y: 220, width: 200, height: 100 });
  expect(taskPageViewport(metrics, { x: 300, y: 0, width: 100, height: 100 }, 1)).toBeNull();
});
it('unmounts while occluded or when the host has no measured position', () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  expect(taskPageViewport({ visible: false, x: 10, y: 20, width: 100, height: 100 }, rect, 1)).toBeNull();
  expect(taskPageViewport({ visible: true, width: 100, height: 100 }, rect, 1)).toBeNull();
});

it('rejects arithmetic overflow before native layout receives non-finite bounds', () => {
  expect(taskPageViewport({ visible: true, x: 0, y: 0, width: 200, height: 100 },
    { x: -1e308, y: 0, width: 1e308, height: 1 }, 2)).toBeNull();
});
