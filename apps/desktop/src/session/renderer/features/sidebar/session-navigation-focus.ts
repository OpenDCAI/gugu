import { makeAutoObservable } from 'mobx';

export type SessionNavFocusLayer = 'nav' | 'composer';

/** The single observable fact consumed by navigation and every session-page auto-focus writer. */
class SessionNavigationFocusStore {
  focusLayer: SessionNavFocusLayer = 'composer';

  constructor() {
    makeAutoObservable(this);
  }

  setFocusLayer(layer: SessionNavFocusLayer): void {
    this.focusLayer = layer;
  }
}

export const sessionNavigationFocus = new SessionNavigationFocusStore();

/** The session composer's input, or any other text field. */
export const COMPOSER_INPUT_SELECTOR =
  '.tiptap[contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"], textarea';

/** Focus on any of these puts the keyboard in the composer layer: they accept characters. */
const COMPOSER_LAYER_SELECTOR = `${COMPOSER_INPUT_SELECTOR}, .xterm-helper-textarea, .cm-editor, webview, iframe`;

export function isComposerLayerElement(element: Element): boolean {
  return element.closest(COMPOSER_LAYER_SELECTOR) !== null;
}

/** The element that really holds focus, looking through open shadow roots (the session page lives in one). */
export function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/**
 * The layer leaving nav is a request when navigation makes it (a session row clicked, ←/→): focus sits on the
 * row and the auto-focus writers place it. It is only an observation when the user's own focus landed on a
 * composer-layer surface — the first click into the file editor beside the chat. Focus is placed then; a writer
 * that answered would pull it out of the editor into the chat.
 */
export function composerLayerHoldsFocus(): boolean {
  const active = deepActiveElement();
  return active !== null && isComposerLayerElement(active);
}
