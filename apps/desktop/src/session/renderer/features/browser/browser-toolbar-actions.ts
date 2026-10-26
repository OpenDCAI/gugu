import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import type { ProjectsTranslate } from '@renderer/localization/messages-projects';
import {
  normalizeBrowserUrl,
  type BrowserDataClearKind,
  type BrowserSessionSnapshot,
} from '@shared/browser';
import type { BrowserWebviewAdapter } from './browser-webview-types';

export function openBrowserUrlExternally(url: string): void {
  if (!canOpenBrowserUrlExternally(url)) return;
  const normalized = normalizeBrowserUrl(url);
  if (normalized.ok) {
    void rpc.app.openExternal(normalized.url);
  }
}

export function canOpenBrowserUrlExternally(url: string): boolean {
  const normalized = normalizeBrowserUrl(url);
  return normalized.ok && (normalized.protocol === 'http:' || normalized.protocol === 'https:');
}

export async function captureBrowserScreenshot(
  session: BrowserSessionSnapshot,
  translate: ProjectsTranslate
): Promise<void> {
  try {
    const result = await rpc.browser.captureScreenshot(session.browserId);
    if (result.success) toast({ title: translate('browser.screenshotCopied') });
  } catch (error) { rendererLogger('actions/browser-toolbar-actions').error({ error: error }, 'action failed'); toast({ title: translate('browser.screenshotFailed'), description: messageForUser(error), variant: 'destructive' }); }

}

export function clearBrowserData(
  session: BrowserSessionSnapshot,
  kind: BrowserDataClearKind,
  onSuccess: () => void,
  translate: ProjectsTranslate
): Promise<void> {
  return rpc.browser
    .clearData(session.browserId, kind)
    .then((result) => {
      if (result.success) {
        onSuccess();
        return;
      }

      toast({
        title: translate('browser.clearDataFailed'),
        description: result.error ? messageForUser(result.error) : translate('browser.clearDataFailedDetail'),
        variant: 'destructive',
      });
    })
    .catch((error: unknown) => {
      console.error('Failed to clear browser data', error);
      toast({
        title: translate('browser.clearDataFailed'),
        description: messageForUser(error),
        variant: 'destructive',
      });
    });
}

export function confirmClearBrowserStorage(
  session: BrowserSessionSnapshot,
  adapter: BrowserWebviewAdapter | null,
  profileLabel: string,
  translate: ProjectsTranslate
): void {
  showModal('confirmActionModal', {
    title: translate('browser.clearStorageTitle'),
    description: translate('browser.clearStorageDescription', { profileLabel }),
    confirmLabel: translate('browser.clearStorageConfirm'),
    variant: 'destructive',
    onSuccess: () => {
      void clearBrowserData(session, 'storage', () => adapter?.reload(), translate);
    },
  });
}
