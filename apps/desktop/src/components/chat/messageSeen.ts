/** Fine steps so a row taller than the view still reports while it scrolls; one 0.6 step never fires for it. */
export const MESSAGE_SEEN_THRESHOLDS: readonly number[] = Array.from({ length: 21 }, (_, step) => step / 20)

const SEEN_SHARE = 0.6

type SeenEntry = Pick<IntersectionObserverEntry, 'isIntersecting' | 'intersectionRatio' | 'intersectionRect' | 'rootBounds'>

/**
 * A message counts as seen once most of it is on screen, or, when it is taller than the view, once it fills
 * most of the view. Without the second half a reply longer than the screen is never read, and its unread
 * count survives the reader scrolling through all of it.
 */
export function messageSeen(entry: SeenEntry): boolean {
  if (!entry.isIntersecting) return false
  if (entry.intersectionRatio >= SEEN_SHARE) return true
  const view = entry.rootBounds?.height ?? 0
  return view > 0 && entry.intersectionRect.height >= view * SEEN_SHARE
}
