import type { MouseInputEvent, MouseWheelInputEvent } from 'electron';

/** Real pointer input landing on the cursor layer, in that layer's CSS pixels. */
export type BrowserCursorInput = MouseInputEvent | MouseWheelInputEvent;

/** The cursor and page have identical bounds; forward only pointer input. */
export function browserCursorInput(input: BrowserCursorInput): BrowserCursorInput | null {
  if (!input || typeof input !== 'object') return null;
  if (!['mouseDown', 'mouseUp', 'mouseMove', 'mouseEnter', 'mouseLeave', 'mouseWheel'].includes(input.type)) return null;
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return null;
  if (input.type === 'mouseWheel') {
    const wheel = input as MouseWheelInputEvent;
    if (!Number.isFinite(wheel.deltaX) || !Number.isFinite(wheel.deltaY)) return null;
  }
  return { ...input, x: Math.round(input.x), y: Math.round(input.y) };
}
