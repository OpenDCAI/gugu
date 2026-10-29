import type { WebContents, WebContentsDidStartNavigationEventParams } from 'electron';
import { isSupportedBrowserNavigationUrl } from './browser-navigation';

/** Prune native history so page scripts and native back inputs share the CDP URL boundary. */
export function pageNavigationAccess(contents: WebContents, revoke: (reason: string) => void) {
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
  contents.on('did-start-navigation', onNavigation);
  return {
    assertCurrent,
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
    dispose() { contents.removeListener('did-start-navigation', onNavigation); },
  };
}
