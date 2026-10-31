import type { WebContents, WebContentsDidStartNavigationEventParams } from 'electron';
import { isSupportedBrowserNavigationUrl } from './browser-navigation';
import { trackPageNavigation } from './page-navigation-tracker';

/** Prune native history so page scripts and native back inputs share the CDP URL boundary. */
export function pageNavigationAccess(contents: WebContents, revoke: (reason: string) => void) {
  const tracked = trackPageNavigation(contents);
  const reason = 'page protocol: unsupported navigation URL';
  const assertCurrent = () => {
    // A new native view has no committed URL yet; it cannot expose an unsupported document.
    if (isSupportedBrowserNavigationUrl(contents.getURL() || 'about:blank')) return;
    revoke(reason);
    throw new Error(reason);
  };
  const onNavigation = (details: WebContentsDidStartNavigationEventParams) => {
    // The person may still open a local page. Stop the borrowed connection before it can read it.
    if (details.isMainFrame && !isSupportedBrowserNavigationUrl(details.url)) revoke(reason);
  };
  const onCommitted = (_event: unknown, url: string) => {
    if (!isSupportedBrowserNavigationUrl(url)) revoke(reason);
  };
  const onRedirect = (_event: unknown, url: string, _inPlace: boolean, main: boolean) => {
    if (main && !isSupportedBrowserNavigationUrl(url)) revoke(reason);
  };
  contents.on('did-start-navigation', onNavigation);
  contents.on('did-navigate', onCommitted);
  contents.on('did-redirect-navigation', onRedirect);
  return {
    assertCurrent,
    waitForIdle(signal: AbortSignal): Promise<void> {
      if (!tracked.unsafeLoading()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          contents.removeListener('did-stop-loading', stopped);
          contents.removeListener('did-start-navigation', stopped);
          contents.removeListener('did-redirect-navigation', stopped);
          contents.removeListener('did-navigate', stopped);
          signal.removeEventListener('abort', aborted);
        };
        const stopped = () => { if (!tracked.unsafeLoading()) { cleanup(); resolve(); } };
        const aborted = () => { cleanup(); reject(signal.reason); };
        const timer = setTimeout(() => {
          cleanup();
          const message = 'page protocol: navigation is still loading';
          revoke(message);
          reject(new Error(message));
        }, 10_000);
        contents.on('did-stop-loading', stopped);
        contents.on('did-start-navigation', stopped);
        contents.on('did-redirect-navigation', stopped);
        contents.on('did-navigate', stopped);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted(); else stopped();
      });
    },
    prepare() {
      assertCurrent();
      const history = contents.navigationHistory;
      const entries = history.getAllEntries(), active = history.getActiveIndex();
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (isSupportedBrowserNavigationUrl(entries[index]!.url)) continue;
        if (index === active || !history.removeEntryAtIndex(index)) {
          const failed = 'page protocol: unsafe navigation history could not be removed';
          revoke(failed);
          throw new Error(failed);
        }
      }
    },
    dispose() {
      contents.removeListener('did-start-navigation', onNavigation);
      contents.removeListener('did-navigate', onCommitted);
      contents.removeListener('did-redirect-navigation', onRedirect);
    },
  };
}
