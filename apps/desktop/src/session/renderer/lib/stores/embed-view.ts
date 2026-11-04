// gugu-embedded: the ONE persistent session-page instance (mounted once at app start, never unmounted —
// see EmdashSessionFrame.tsx's "常驻不卸载" comment) can render either the full session-page Workspace or the
// session-create root, depending on which gugu surface currently needs it. Two independent module loads
// were considered and rejected: ES modules execute once per URL per document, so a second
// `<script type=module src=embedded.js>` would not re-run bootstrap(); forcing a second execution via a
// cache-busted URL would cold-boot a second full session-page instance (~30s, plus a second copy of every
// module-level singleton below). A single reactively-switched root avoids that: this store is
// embedded.tsx's app-level counterpart to portal-container.ts's isEmbedVisible/subscribeEmbedVisibility
// (same pattern, different concern).
// @@@4321 这段从前还有一条理由:「两份实例各有一份 session-ui,而它的 portal 原语直读 window 全局,
// 后启动的会把先启动的浮层偷进错的容器」。那条**已经不成立** —— 浮层容器改由 React context 按树声明,
// 每棵树各自解析自己的容器。删掉它而不是留着:它描述的是一个已经不存在的机制。
export type EmbedView = 'workspace' | 'session-create';

let embedView: EmbedView = 'workspace';
const embedViewListeners = new Set<() => void>();

export function setEmbedView(view: EmbedView): void {
  if (embedView === view) return;
  embedView = view;
  for (const listener of embedViewListeners) listener();
}

export function getEmbedView(): EmbedView {
  return embedView;
}

export function subscribeEmbedView(listener: () => void): () => void {
  embedViewListeners.add(listener);
  return () => {
    embedViewListeners.delete(listener);
  };
}
