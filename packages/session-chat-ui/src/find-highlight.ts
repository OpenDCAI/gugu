/** The mounted row's range for the match: the occurrence nearest `expected` non-whitespace characters in. */
export function locateFindRange(row: HTMLElement, query: string, expected: number, excludedClass?: string): Range | null {
  const needle = query.replace(/\s+/gu, '').toLowerCase();
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let el = node.parentElement; el && el !== row; el = el.parentElement) {
        if (el.getAttribute('aria-hidden') === 'true' || (!!excludedClass && el.classList.contains(excludedClass))) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = '';
  const at: { node: Text; offset: number }[] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    let offset = 0;
    for (const ch of node.data) {
      if (/\S/u.test(ch)) {
        const lower = ch.toLowerCase();
        text += lower;
        for (let k = 0; k < lower.length; k++) at.push({ node, offset });
      }
      offset += ch.length;
    }
  }
  let best = -1;
  for (let i = needle ? text.indexOf(needle) : -1; i !== -1; i = text.indexOf(needle, i + 1)) {
    if (best === -1 || Math.abs(i - expected) < Math.abs(best - expected)) best = i;
    if (i > expected) break;
  }
  const first = at[best];
  const last = at[best + needle.length - 1];
  if (best === -1 || !first || !last) return null;
  const range = row.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + String.fromCodePoint(last.node.data.codePointAt(last.offset) ?? 0).length);
  return range;
}

type Highlights = { set(name: string, value: unknown): void; delete(name: string): void };
const painters = new WeakMap<Document, object>();
/** One registry per document: only the owner that painted the current match may erase it. */
export function paintFindHighlight(document: Document, owner: object, range: Range | null): void {
  const view = document.defaultView as unknown as { CSS?: { highlights?: Highlights }; Highlight?: new (r: Range) => unknown } | null;
  if (!view?.CSS?.highlights || !view.Highlight) return;
  if (range) {
    painters.set(document, owner);
    view.CSS.highlights.set('gugu-chat-find', new view.Highlight(range));
  } else if (painters.get(document) === owner) {
    painters.delete(document);
    view.CSS.highlights.delete('gugu-chat-find');
  }
}
