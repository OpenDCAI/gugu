import { describe, expect, it } from 'vitest';
import {
  anchorScrollDelta,
  DOCUMENT_MAX_ZOOM,
  DOCUMENT_MIN_ZOOM,
  imageFitScale,
  imageMaxScale,
  isPinchWheel,
  pinchZoom,
  pointerFraction,
} from './pinch-zoom';

/** #6456: 查看面板里的双指捏合 —— 只缩放内容,换算在这一处。 */
describe('pinch zoom', () => {
  it('only treats a ctrl-wheel as a pinch, so plain two-finger scrolling still scrolls', () => {
    expect(isPinchWheel({ ctrlKey: true })).toBe(true);
    expect(isPinchWheel({ ctrlKey: false })).toBe(false);
  });

  it('zooms in when the fingers spread (deltaY < 0) and out when they close', () => {
    expect(pinchZoom(1, -50, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM)).toBeGreaterThan(1);
    expect(pinchZoom(1, 50, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM)).toBeLessThan(1);
    // 张开再合拢同样幅度,回到原处。
    const there = pinchZoom(1, -50, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM);
    expect(pinchZoom(there, 50, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM)).toBeCloseTo(1, 10);
  });

  it('stays within the limits however far the gesture goes', () => {
    expect(pinchZoom(1, -100_000, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM)).toBe(DOCUMENT_MAX_ZOOM);
    expect(pinchZoom(1, 100_000, DOCUMENT_MIN_ZOOM, DOCUMENT_MAX_ZOOM)).toBe(DOCUMENT_MIN_ZOOM);
  });

  it('brings the same point of the image back under the pointer, wherever the image moved', () => {
    // 图片从屏幕 x=50 起、宽 100,指针在 x=80 → 指着图片的 30% 处。
    const fraction = pointerFraction(80, 50, 100);
    expect(fraction).toBeCloseTo(0.3, 10);
    // 放大后图片(居中留白也跟着变了)从 x=20 起、宽 300:30% 处现在在 x=110,要再滚 30 才回到指针下。
    expect(anchorScrollDelta(20, 300, fraction, 80)).toBeCloseTo(30, 10);
  });

  it('anchors to the nearest edge when the pointer is off the image', () => {
    expect(pointerFraction(10, 50, 100)).toBe(0);
    expect(pointerFraction(500, 50, 100)).toBe(1);
    expect(pointerFraction(80, 50, 0)).toBe(0);
  });
});

describe('image zoom range', () => {
  it('fits an image into the pane without enlarging a small one', () => {
    expect(imageFitScale({ width: 2000, height: 1000 }, { width: 1000, height: 1000 })).toBe(0.5);
    expect(imageFitScale({ width: 200, height: 100 }, { width: 1000, height: 1000 })).toBe(1);
  });

  it('lets a long screenshot zoom up to at least twice its real size', () => {
    // 1080×11020 的长图放进 900×800 的窗格:适合窗格时只有原图的 7%,字看不清。
    const fit = imageFitScale({ width: 1080, height: 11020 }, { width: 900, height: 800 });
    expect(fit).toBeLessThan(0.1);
    expect(imageMaxScale(fit)).toBeGreaterThanOrEqual(2);
  });

  it('caps a small image at a few times its fitted size', () => {
    expect(imageMaxScale(1)).toBe(8);
  });
});
