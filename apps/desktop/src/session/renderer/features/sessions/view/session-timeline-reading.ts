import { READING_LINE } from './session-timeline-geometry';

/** Read the first row crossing the reading line from browser-owned intersection geometry. */
export function observeReadingTurn(
  host: HTMLElement,
  turnOfItem: ReadonlyMap<string, string>,
  onChange: (turn: string | null) => void,
): () => void {
  let scroller: HTMLElement | null = null;
  let intersection: IntersectionObserver | null = null;
  let stopped = false;
  const rows = new Set<HTMLElement>();
  const visible = new Set<HTMLElement>();
  const publish = () => {
    let first: HTMLElement | null = null;
    for (const row of visible) {
      if (!turnOfItem.has(row.dataset.itemId ?? '')) continue;
      if (!first || first.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING) first = row;
    }
    onChange(first ? turnOfItem.get(first.dataset.itemId!) ?? null : null);
  };
  const syncRows = () => {
    const next = host.querySelector<HTMLElement>('[data-chat-scroll]');
    if (next !== scroller) {
      intersection?.disconnect(); rows.clear(); visible.clear(); scroller = next;
      // Match the positive-area predicate below: threshold 0 misses a row that
      // was already intersecting with zero area exactly at the viewport edge.
      intersection = scroller ? new IntersectionObserver(entries => {
        if (stopped) return;
        for (const entry of entries) {
          const row = entry.target as HTMLElement;
          if (!rows.has(row)) continue;
          if (entry.isIntersecting && entry.intersectionRect.height > 0) visible.add(row);
          else visible.delete(row);
        }
        publish();
      }, { root: scroller, rootMargin: `-${READING_LINE}px 0px 0px 0px`, threshold: Number.EPSILON }) : null;
    }
    if (!scroller || !intersection) { onChange(null); return; }
    const current = new Set(scroller.querySelectorAll<HTMLElement>('[data-item-id]'));
    let removed = false;
    for (const row of rows) if (!current.has(row)) {
      intersection.unobserve(row); rows.delete(row); visible.delete(row); removed = true;
    }
    for (const row of current) if (!rows.has(row)) { rows.add(row); intersection.observe(row); }
    if (visible.size || removed || current.size === 0) publish();
  };
  // Rows are virtualised and the scroll root can be replaced. Updating this membership
  // reads the DOM tree only; text arrivals never synchronously flush layout.
  const mutation = new MutationObserver(syncRows);
  mutation.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-item-id'] });
  syncRows();
  return () => { stopped = true; mutation.disconnect(); intersection?.disconnect(); rows.clear(); visible.clear(); };
}
