import type { TabCloseRequest, TabEntry, TabHandle, TabProvider, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { SessionTabBarItem, SessionTabBarItemDragPreview } from './session-tab-item';
import { SessionTabResource } from './session-tab-resource';
import { getSessionPtyManager } from './stores/session-pty-manager';
import { confirmCloseSessionTab } from './close-session-tab-flow';

export interface SessionState {
  sessionId: string;
}

export interface SessionOpenArgs {
  sessionId: string;
}

export const sessionTabProvider: TabProvider<
  'session',
  SessionState,
  SessionTabResource,
  SessionOpenArgs
> = createTabProvider({
  kind: 'session',
  mount: 'single',
  resourceKey: (state: SessionState) => state.sessionId,
  onBeforeOpen: (args: SessionOpenArgs): SessionState => ({
    sessionId: args.sessionId,
  }),

  initialize(entry: TabEntry<SessionState>, handle: TabHandle, ctx: TabViewContext) {
    const { sessionId } = ctx as SessionTabContext;
    // Hold the tab and its one reference while the registry loads. The resource
    // observes the real result instead of closing and reopening on a timer.
    getSessionPtyManager(sessionId).acquire(entry.state.sessionId);
    return new SessionTabResource(entry.state.sessionId, handle);
  },

  // 关掉这一块会话自己那枚,它还开着别的页签 → 问「会话和页签都关 / 只关会话」(spec session-page「页签」)。
  onBeforeClose: (entry: TabEntry<SessionState>, _resource: SessionTabResource, ctx: TabViewContext, request: TabCloseRequest) =>
    confirmCloseSessionTab(entry.state.sessionId, ctx, request),

  dispose(entry: TabEntry<SessionState>, _resource: SessionTabResource, ctx: TabViewContext) {
    getSessionPtyManager((ctx as SessionTabContext).sessionId).release(entry.state.sessionId);
  },

  commands: {
    rename: {
      label: 'Rename',
      exec: (resource: SessionTabResource, name?: string) => {
        if (name) resource.rename(name);
      },
    },
  },
  TabBarItem: SessionTabBarItem,
  TabBarItemDragPreview: SessionTabBarItemDragPreview,
  TabContent: registeredTabView('session'),
});
