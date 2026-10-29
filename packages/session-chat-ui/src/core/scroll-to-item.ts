import type { ScrollToItemOptions } from '../commands';

/** Center in the readable viewport; an oversized item starts below its pinned question. */
export function itemScrollTarget(input: {
  rowTop: number;
  rowHeight: number;
  viewportHeight: number;
  topInset: number;
  align: NonNullable<ScrollToItemOptions['align']>;
  offset: number;
}): number {
  const { rowTop, rowHeight, viewportHeight, topInset, align, offset } = input;
  const target = align === 'center'
    ? rowTop - topInset - Math.max(0, (viewportHeight - topInset - rowHeight) / 2)
    : align === 'end' ? rowTop - viewportHeight + rowHeight : rowTop;
  return Math.max(0, target + offset);
}
