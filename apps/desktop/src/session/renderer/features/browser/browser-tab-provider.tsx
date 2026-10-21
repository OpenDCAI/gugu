import { workspaceBackend } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { browserSessionStore } from '@renderer/features/browser/browser-session-store';
import { getAppSettingValueSnapshot } from '@renderer/features/settings/app-settings-client';
import type { TabEntry, TabHandle, TabProvider, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { normalizeBrowserProfileSelection } from '@shared/browser';
import type { BrowserSessionSnapshot } from '@shared/browser';
import { BrowserTabBarItem, BrowserTabBarItemDragPreview } from './browser-tab-item';
import { BrowserTabResource } from './browser-tab-resource';

// 浏览器页签只有这一种。会话在别的机器上时,工作区后端给它装上那台机器的那一半(workspace-browser-backend):
// localhost 端口经 SSH 转过来、file: 网页从那台机器取、ssh 要问人时画一张提问卡片 —— 页签、地址栏、加载失败页都是同一个。

export interface BrowserState {
  browserId: string;
  /** Session snapshot — kept current by BrowserTabResource's MobX reaction. */
  session: BrowserSessionSnapshot;
  /** 转发的端口活不过应用重启(别的机器上的会话):❌ 从快照里复活一个地址栏指着没人监听的本机端口的页签。 */
  ephemeral?: true;
}

export interface BrowserOpenArgs {
  initialUrl?: string;
}

export const browserTabProvider: TabProvider<
  'browser',
  BrowserState,
  BrowserTabResource,
  BrowserOpenArgs
> = createTabProvider({
  kind: 'browser',
  resourceKey: (s: BrowserState) => s.browserId,
  // 两个网页并排:两页都在这一层里各摆一边,❌ 另一页单独挂一份(挪过去 = 重新加载)。
  placesPairItself: true,
  isPersistent: (s: BrowserState) => !s.ephemeral,

  // No mount: multi. Each open creates a fresh browser session.

  /**
   * Creates a new browser session and returns it as the initial state.
   * Returns null to abort if session creation fails (shouldn't happen).
   */
  onBeforeOpen(args: BrowserOpenArgs, ctx: TabViewContext): BrowserState | null {
    const sessionCtx = ctx as SessionTabContext;
    const browserSettings = getAppSettingValueSnapshot('browser');
    const profileId = normalizeBrowserProfileSelection(
      browserSettings?.defaultProfileId,
      browserSettings?.profiles
    );
    const session = browserSessionStore.createSession({
      projectId: sessionCtx.projectId,
      workspaceId: sessionCtx.workspaceId,
      sessionId: sessionCtx.sessionId,
      profileId,
      initialUrl: args.initialUrl,
    });
    const persistent = workspaceBackend(sessionCtx.projectId).browser.persistent;
    return persistent ? { browserId: session.browserId, session } : { browserId: session.browserId, session, ephemeral: true };
  },

  initialize(
    entry: TabEntry<BrowserState>,
    handle: TabHandle,
    ctx: TabViewContext
  ): BrowserTabResource {
    const sessionCtx = ctx as SessionTabContext;
    return new BrowserTabResource(entry, handle, (browserId) =>
      workspaceBackend(sessionCtx.projectId).browser.attach(browserId, sessionCtx),
      { projectId: sessionCtx.projectId, workspaceId: sessionCtx.workspaceId }
    );
  },

  dispose(_entry: TabEntry<BrowserState>, resource: BrowserTabResource): void {
    resource.dispose();
  },

  TabBarItem: BrowserTabBarItem,
  TabBarItemDragPreview: BrowserTabBarItemDragPreview,
  TabContent: registeredTabView('browser'),
});
