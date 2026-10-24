import { rpc } from '@renderer/lib/ipc';
import type { AppModalPage } from '@shared/extensions/app-modal';
import type { BrowserWebviewElement } from '@renderer/features/browser/browser-webview-types';
import { showAppModal } from '@/components/appModal/appModal';

export function openDesktopAppModal(page: AppModalPage): void {
  let guest: BrowserWebviewElement | null = null;
  let previous = document.activeElement;
  while (previous?.shadowRoot?.activeElement) previous = previous.shadowRoot.activeElement;
  const dismiss = (error?: string) => rpc.extensions.dismissModal({ id: page.id, ...(error ? { error } : {}) }).then(() => undefined);
  const fail = (error: unknown) => dismiss(error instanceof Error ? error.message : String(error));
  const focus = async (edge: 'first' | 'last') => {
    guest?.focus();
    await rpc.extensions.focusModal({ id: page.id, edge });
  };
  showAppModal({
    id: page.id, title: page.title, appName: page.appName, size: page.size,
    url: page.entryUrl, partition: page.partition,
    opener: previous instanceof HTMLElement ? previous : document.body,
    focus, dismiss,
    attach(element) {
      guest = element as BrowserWebviewElement;
      const ready = () => void rpc.extensions.bindModal({ id: page.id, webContentsId: guest!.getWebContentsId() }).then(() => focus('first')).catch(fail);
      const gone = () => void fail(new Error('The App modal content process exited'));
      const failed = (event: Event) => {
        const failure = event as Event & { errorCode?: number; errorDescription?: string };
        if (failure.errorCode !== -3) void fail(new Error(failure.errorDescription ?? 'The App modal page did not load'));
      };
      element.addEventListener('dom-ready', ready);
      element.addEventListener('render-process-gone', gone);
      element.addEventListener('did-fail-load', failed);
      return () => {
        element.removeEventListener('dom-ready', ready);
        element.removeEventListener('render-process-gone', gone);
        element.removeEventListener('did-fail-load', failed);
        guest = null;
      };
    },
  });
}
