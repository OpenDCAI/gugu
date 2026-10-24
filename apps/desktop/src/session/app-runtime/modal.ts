import { coded, type GuguHost } from './host';

/** Keyboard events stay in a guest document. The runtime hands only its unconsumed edges to the host. */
export function createModalApi(host: GuguHost) {
  const modal = host.modal!;
  let content = false;
  const focusable = () => [...document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[contenteditable]:not([contenteditable=false]),[tabindex]')]
    .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0)
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
  const report = (error: unknown) => void host.reportError(`App modal: ${error instanceof Error ? error.message : String(error)}`);

  host.onModalFocus!((edge) => {
    content = true;
    const focus = () => {
      const candidates = focusable();
      const target = edge === 'last' ? candidates.at(-1) : candidates.find((element) => element.hasAttribute('autofocus')) ?? candidates[0];
      if (target) target.focus();
      else { document.body.tabIndex = -1; document.body.focus(); }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', focus, { once: true });
    else focus();
  });
  window.addEventListener('keydown', (event) => {
    if (!content || event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      void modal.close().catch(report);
    } else if (event.key === 'Tab') {
      const candidates = focusable();
      const boundary = event.shiftKey ? candidates[0] : candidates.at(-1);
      if (!candidates.length || document.activeElement === boundary) {
        event.preventDefault();
        void modal.key('tab').catch(report);
      }
    }
  });

  return Object.freeze({
    open(options: { entry: string; title: string; size?: string; data?: unknown }): Promise<unknown> {
      const previous = document.activeElement;
      const hadFocus = document.hasFocus();
      const result = coded(modal.open)({ ...options, id: crypto.randomUUID() });
      return result.finally(() => {
        if (hadFocus && previous instanceof HTMLElement && previous.isConnected) previous.focus();
      });
    },
    close: coded((result?: unknown) => modal.close(result)),
  });
}
