import { rpc } from '@renderer/lib/ipc';
import { desktopIpc } from '@/platform/desktopIpc';
import { EXTENSION_BRIDGE_CHANNEL, type ExtensionBridgeResponse } from '@shared/extensions/bridge-protocol';
import type { AppModalHostAction, AppModalPage } from '@shared/extensions/app-modal';
import type { BrowserWebviewElement } from '@renderer/features/browser/browser-webview-types';
import { showAppModal } from '@/components/appModal/appModal';

export function openDesktopAppModal(page: AppModalPage): void {
  let guest: BrowserWebviewElement | null = null;
  let previous = document.activeElement;
  while (previous?.shadowRoot?.activeElement) previous = previous.shadowRoot.activeElement;
  const control = async (action: AppModalHostAction) => {
    const response = await desktopIpc()!.invoke(EXTENSION_BRIDGE_CHANNEL, { method: 'modalHost', args: action }) as ExtensionBridgeResponse;
    if (!response.ok) throw new Error(response.message);
  };
  const dismiss = (error?: string) => control({ type: 'dismiss', id: page.id, ...(error ? { error } : {}) });
  const fail = (error: unknown) => dismiss(error instanceof Error ? error.message : String(error));
  const focus = async (edge: 'first' | 'last') => {
    guest?.focus();
    await control({ type: 'focus', id: page.id, edge });
  };
  showAppModal({
    id: page.id, title: page.title, appName: page.appName, size: page.size,
    url: page.entryUrl, partition: page.partition,
    opener: previous instanceof HTMLElement ? previous : document.body,
    focus, dismiss,
    attach(element) {
      guest = element as BrowserWebviewElement;
      let boundId: number | null = null;
      const report = () => {
        if (boundId !== null) void rpc.extensions.reportLayout({ webContentsId: boundId, visible: true, width: element.clientWidth, height: element.clientHeight }).catch(fail);
      };
      const observer = new ResizeObserver(report);
      observer.observe(element);
      const ready = () => {
        const webContentsId = (element as BrowserWebviewElement).getWebContentsId();
        void control({ type: 'bind', id: page.id, webContentsId }).then(() => {
          if (guest !== element) return;
          boundId = webContentsId; report(); return focus('first');
        }).catch((error: unknown) => { if (guest === element) void fail(error); });
      };
      const gone = () => void fail(new Error('The App modal content process exited'));
      const failed = (event: Event) => {
        const failure = event as Event & { errorCode?: number; errorDescription?: string };
        if (failure.errorCode !== -3) void fail(new Error(failure.errorDescription ?? 'The App modal page did not load'));
      };
      element.addEventListener('dom-ready', ready);
      element.addEventListener('render-process-gone', gone);
      element.addEventListener('did-fail-load', failed);
      return () => {
        observer.disconnect();
        element.removeEventListener('dom-ready', ready);
        element.removeEventListener('render-process-gone', gone);
        element.removeEventListener('did-fail-load', failed);
        guest = null;
      };
    },
  });
}
