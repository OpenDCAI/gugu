// gugu-embedded: when the session page runs inside gugu's Shadow-DOM 会话页 mount, portals must land
// INSIDE the shadow root — all session-page CSS lives there, so anything portaled to document.body
// (Base UI's default) renders completely unstyled in the light DOM. embedded.tsx points this
// at a layer element in the shadow root; the standalone build never sets it, so every portal
// keeps its document.body default.
let portalContainer: HTMLElement | null = null;

export function setPortalContainer(el: HTMLElement | null): void {
  portalContainer = el;
}

// undefined → Base UI falls back to document.body.
export function getPortalContainer(): HTMLElement | undefined {
  return portalContainer ?? undefined;
}

// For raw createPortal call sites that need a concrete element.
export function getPortalContainerOrBody(): HTMLElement {
  return portalContainer ?? document.body;
}

// gugu-embedded: the host keeps the session-page frame MOUNTED but display-hidden when the user is on
// another tab (unmounting = full 14MB re-boot on return). Document-level hotkeys (⌘K palette…)
// must not fire — or steal focus into invisible modals — while hidden. The host flips this via
// window.__EMDASH_SET_VISIBLE__; a standalone session page never calls it, so hotkeys stay always-on.
let embedVisible = true;
const embedVisibilityListeners = new Set<() => void>();

export function setEmbedVisible(visible: boolean): void {
  if (embedVisible === visible) return;
  embedVisible = visible;
  for (const listener of embedVisibilityListeners) listener();
}

export function isEmbedVisible(): boolean {
  return embedVisible;
}

export function subscribeEmbedVisibility(listener: () => void): () => void {
  embedVisibilityListeners.add(listener);
  return () => {
    embedVisibilityListeners.delete(listener);
  };
}
