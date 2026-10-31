import { getChunks } from '@codemirror/merge';
import { EditorView, ViewPlugin } from '@codemirror/view';

/** The existing diff overview has deletion, modification and insertion lanes. */
export const diffOverview = ViewPlugin.fromClass(class {
  readonly dom = document.createElement('div');
  readonly scroll: HTMLElement;
  readonly resize: ResizeObserver;
  constructor(readonly view: EditorView) {
    this.dom.className = 'cm-diff-overview';
    this.dom.style.cssText = 'position:absolute;right:0;top:0;bottom:0;width:9px;z-index:2';
    this.dom.setAttribute('aria-hidden', 'true');
    view.dom.appendChild(this.dom);
    this.scroll = view.dom.closest<HTMLElement>('.cm-mergeView') ?? view.scrollDOM;
    this.scroll.addEventListener('scroll', this.place);
    this.resize = new ResizeObserver(this.place);
    this.resize.observe(this.scroll);
    this.dom.addEventListener('pointerdown', this.jump);
    this.render();
  }
  update() { this.render(); }
  private place = () => {
    this.dom.style.bottom = 'auto';
    this.dom.style.top = `${this.scroll === this.view.scrollDOM ? 0 : this.scroll.scrollTop}px`;
    this.dom.style.height = `${this.scroll.clientHeight}px`;
  };
  /** The ruler spans the scrollable height, so markers sit level with their lines when the document is short. */
  private get total() { return Math.max(this.view.contentHeight, this.scroll.clientHeight); }
  private jump = (event: PointerEvent) => {
    event.preventDefault();
    const rect = this.dom.getBoundingClientRect();
    const height = (event.clientY - rect.top) / rect.height * this.total - this.view.documentPadding.top;
    this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.lineBlockAtHeight(height).from, { y: 'center' }) });
  };
  private render() {
    this.place();
    const info = getChunks(this.view.state);
    this.dom.replaceChildren();
    if (!info) return;
    const { doc } = this.view.state;
    const total = this.total;
    const pad = this.view.documentPadding.top;
    for (const chunk of info.chunks) {
      const from = Math.min(info.side === 'a' ? chunk.fromA : chunk.fromB, doc.length);
      const end = Math.min(info.side === 'a' ? chunk.endA : chunk.endB, doc.length);
      const top = this.view.lineBlockAt(from).top;
      const bottom = this.view.lineBlockAt(Math.max(from, end - 1)).bottom;
      const deleted = chunk.fromB === chunk.toB;
      const added = chunk.fromA === chunk.toA;
      const marker = document.createElement('div');
      const lane = deleted ? 0 : added ? 2 : 1;
      marker.style.cssText = `position:absolute;left:${lane * 3}px;width:3px;min-height:3px;top:${(pad + top) / total * 100}%;height:${(bottom - top) / total * 100}%;background:var(--foreground-diff-${deleted ? 'deleted' : added ? 'added' : 'modified'})`;
      this.dom.appendChild(marker);
    }
  }
  destroy() {
    this.resize.disconnect();
    this.scroll.removeEventListener('scroll', this.place);
    this.dom.removeEventListener('pointerdown', this.jump);
    this.dom.remove();
  }
});
