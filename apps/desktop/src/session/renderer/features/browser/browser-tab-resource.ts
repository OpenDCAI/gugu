import { reaction } from 'mobx';
import { browserDiagnosticsStore } from '@renderer/features/browser/browser-diagnostics-store';
import { browserSessionStore } from '@renderer/features/browser/browser-session-store';
import type { TabEntry, TabHandle, TabResource } from '@renderer/features/tabs/core/tab-provider';
import { events, rpc } from '@renderer/lib/ipc';
import type { BrowserSessionSnapshot } from '@shared/browser';
import { browserOpenInNewTabChannel, browserPageEventChannel } from '@shared/events/browserEvents';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { fileUrlToMachinePath } from '@shared/preview/remote-page-url';
import { touchesPageAssets } from '@renderer/lib/editor/page-assets';
import { workspaceEvents, workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { browserControlsRegistry } from './browser-controls-registry';
import type { WorkspaceBrowserAttachment } from '@renderer/features/sessions/workspace-backend/workspace-browser-backend';
import type { BrowserState } from './browser-tab-provider';

/**
 * Domain resource for a single open browser tab.
 *
 * On construction, restores the browser session if needed (from snapshot).
 * On dispose, clears diagnostics, removes the session, and unregisters from RPC.
 *
 * Subscribes to the open-in-new-tab event and opens a sibling browser tab via
 * handle.open('browser', { initialUrl }).
 *
 * Maintains a MobX reaction to keep entry.state.session current so that
 * snapshots always reflect the live URL/title — no `getSerializablePayload` needed.
 */
export class BrowserTabResource implements TabResource {
  readonly browserId: string;
  private readonly _unsubscribeOpenInNewTab: () => void;
  private readonly _disposeSessionSync: () => void;
  private readonly _unsubscribePageState: () => void;
  private readonly _stopLiveReload: () => void;
  private readonly _stopPageDirectoryWatch: () => void;
  private _releasePageDirectory: () => void = () => {};
  /** 会话在别的机器上时,那台机器的那一半(端口转发 / 网页预览 / ssh 提问);这台电脑 = null。 */
  readonly attachment: WorkspaceBrowserAttachment | null;

  constructor(
    entry: TabEntry<BrowserState>,
    handle: TabHandle,
    attach?: (browserId: string) => WorkspaceBrowserAttachment | null,
    workspace?: { projectId: string; workspaceId: string }
  ) {
    const payload = entry.state;
    this.browserId = payload.browserId;

    // Restore the session if it doesn't exist yet (snapshot restore path).
    // On fresh open, the session was already created in onBeforeOpen().
    if (!browserSessionStore.getSession(payload.browserId)) {
      browserSessionStore.restoreSession(payload.session, undefined);
    }
    this.attachment = attach?.(this.browserId) ?? null;
    // Browser Use may restore this page while its React surface is unmounted. Persist navigation from the
    // page itself, so switching back or the next restoration cannot reload an obsolete saved URL.
    this._unsubscribePageState = events.on(browserPageEventChannel, (event) => {
      if (event.browserId !== this.browserId) return;
      if (!['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading'].includes(event.type)) return;
      browserSessionStore.updateSession(this.browserId, {
        currentUrl: event.state.url,
        title: event.state.title,
        canGoBack: event.state.canGoBack,
        canGoForward: event.state.canGoForward,
      });
    });

    // Subscribe to open-in-new-tab requests for this browser.
    this._unsubscribeOpenInNewTab = events.on(
      browserOpenInNewTabChannel,
      ({ sourceBrowserId, url }: { sourceBrowserId: string; url: string }) => {
        if (sourceBrowserId !== this.browserId) return;
        handle.open('browser', { initialUrl: url });
      }
    );

    // 开着会话目录里的 `file:` 网页时:那一页或它旁边的资源在盘上变了 ⇒ 重载(照 VS Code Live Preview 存盘即刷新)。
    // 这台电脑与别的机器同一条:变化都从这个工作区的 `files:changes` 来,地址栏里显示的都是那台机器上的 `file:` 地址。
    this._stopLiveReload = workspace
      ? workspaceEvents.on(fileChangesChannel, (event) => {
          if (event.workspaceId !== workspace.workspaceId) return;
          const current = browserSessionStore.getSession(this.browserId)?.currentUrl ?? '';
          const page = current.startsWith('file:') ? fileUrlToMachinePath(current) : null;
          if (!page) return;
          const touched =
            event.update.kind === 'resync' ||
            touchesPageAssets(page, event.update.changes.map((change) => change.path), true);
          if (touched) browserControlsRegistry.get(this.browserId)?.adapter?.reload();
        })
      : () => {};

    // 告诉页面所在的机器「我在看这一页所在的目录」:一个目录一个 watch 的平台上,变化流只看被这样报过的目录
    // (@@@tree-by-directories)。地址换了就换一个目录。
    this._stopPageDirectoryWatch = workspace
      ? reaction(
          () => {
            const current = browserSessionStore.getSession(this.browserId)?.currentUrl ?? '';
            const page = current.startsWith('file:') ? fileUrlToMachinePath(current) : null;
            return page ? page.slice(0, page.lastIndexOf('/')) || null : null;
          },
          (dir) => {
            this._releasePageDirectory();
            if (!dir) return;
            const rpcFiles = workspaceRpc(workspace.projectId).files;
            const lease = rpcFiles
              .watchDirectory(workspace.projectId, workspace.workspaceId, dir)
              .then((result) => (result.success ? result.data.leaseId : null))
              .catch(() => null);
            this._releasePageDirectory = () => {
              this._releasePageDirectory = () => {};
              void lease.then((leaseId) => {
                if (leaseId) void rpcFiles.releaseDirectoryWatch(workspace.projectId, workspace.workspaceId, leaseId).catch(() => {});
              });
            };
          },
          { fireImmediately: true }
        )
      : () => {};

    // Keep entry.state.session in sync with the live session store so that
    // snapshots captured from entry.state always reflect the current URL/title.
    this._disposeSessionSync = reaction(
      () => browserSessionStore.getSnapshot(this.browserId),
      (liveSession) => {
        if (liveSession) {
          entry.state = { ...entry.state, session: liveSession };
        }
      }
    );
  }

  dispose(): void {
    this.attachment?.dispose();
    this._stopLiveReload();
    this._stopPageDirectoryWatch();
    this._releasePageDirectory();
    this._unsubscribeOpenInNewTab();
    this._disposeSessionSync();
    this._unsubscribePageState();
    browserDiagnosticsStore.clearBrowser(this.browserId);
    browserSessionStore.removeSession(this.browserId);
    void rpc.browser.unregisterSession(this.browserId);
  }

  /** Current live session snapshot (for display). */
  get session(): BrowserSessionSnapshot | undefined {
    return browserSessionStore.getSession(this.browserId);
  }
}
