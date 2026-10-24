import { observer } from 'mobx-react-lite';
import type { ResolvedTab, TabBarItemProps, TabCloseRequest, TabEntry, TabHandle, TabProvider, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { MAX_SESSION_TITLE_LENGTH } from '@shared/core/sessions/sessions';
import { SessionAgentIcon } from '../session-agent-icon';
import { formatSessionTitleForDisplay } from '../session-title-utils';
import { sessionRegistry } from '../stores/session-registry';
import { acpChatResources } from './acp-chat-resources';
import { confirmCloseSessionTab } from '../close-session-tab-flow';
import { AcpChatTabResource } from './acp-chat-tab-resource';
import { useSessionTabCommands } from '../view/session-actions';

export interface AcpChatState {
  sessionId: string;
}

export interface AcpChatOpenArgs {
  sessionId: string;
}

export const AcpChatTabBarItem = observer(function AcpChatTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<AcpChatTabResource>) {
  const store = tab.resource.store;
  const session = sessionRegistry
    .get(store.sessionId)
    ?.sessions.get(store.sessionId);
  const providerId = session?.data.providerId ?? '';
  const rawTitle = session?.data.title ?? '';
  const label = session
    ? formatSessionTitleForDisplay(session.data.providerId, session.data.title)
    : 'ACP Chat';
  // 会话的名字在这枚页签上,它的动作(置顶 / 重命名 / 重启 / 换展示 / 归档)就在它的右键里(#7052)。
  const sessionCommands = useSessionTabCommands(store.sessionId, () => host.requestRename(tab.tabId));

  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={label}
      preSlot={<SessionAgentIcon providerId={providerId} isAcp size={16} />}
      statusSlot={
        session ? (
          <AgentStatusIndicator status={session.indicatorStatus} detail={session.detail} disableTooltip />
        ) : undefined
      }
      kindCommands={
        sessionCommands.length > 0
          ? sessionCommands
          : [
              {
                id: 'session:rename',
                label: 'Rename',
                group: 'edit',
                shortcut: 'session.tabRename',
                run: () => host.requestRename(tab.tabId),
              },
            ]
      }
      renameValue={rawTitle}
      renameMaxLength={MAX_SESSION_TITLE_LENGTH}
    />
  );
});

export const AcpChatTabBarItemDragPreview = observer(function AcpChatTabBarItemDragPreview({
  tab,
}: {
  tab: ResolvedTab<AcpChatTabResource>;
}) {
  const store = tab.resource.store;
  const session = sessionRegistry
    .get(store.sessionId)
    ?.sessions.get(store.sessionId);
  const providerId = session?.data.providerId ?? '';
  const label = session
    ? formatSessionTitleForDisplay(session.data.providerId, session.data.title)
    : 'ACP Chat';

  return (
    <GenericTabDragPreview
      preSlot={<SessionAgentIcon providerId={providerId} isAcp size={16} />}
      label={label}
    />
  );
});

export const acpChatTabProvider: TabProvider<
  'acp-chat',
  AcpChatState,
  AcpChatTabResource,
  AcpChatOpenArgs
> = createTabProvider({
  kind: 'acp-chat',
  mount: 'single',
  resourceKey: (s: AcpChatState) => s.sessionId,

  onBeforeOpen: (args: AcpChatOpenArgs): AcpChatState | null => {
    return { sessionId: args.sessionId };
  },

  initialize(
    entry: TabEntry<AcpChatState>,
    _handle: TabHandle,
    ctx: TabViewContext
  ): AcpChatTabResource {
    const sessionCtx = ctx as SessionTabContext;
    const manager = acpChatResources(sessionCtx.sessionId, sessionCtx.projectId);
    const store = manager.acquire(entry.state.sessionId);
    return new AcpChatTabResource(store);
  },

  // 关掉这一块会话自己那枚,它还开着别的页签 → 问「会话和页签都关 / 只关会话」(spec session-page「页签」)。
  onBeforeClose: (entry: TabEntry<AcpChatState>, _resource: AcpChatTabResource, ctx: TabViewContext, request: TabCloseRequest) =>
    confirmCloseSessionTab(entry.state.sessionId, ctx, request),

  dispose(entry: TabEntry<AcpChatState>, _resource: AcpChatTabResource, ctx: TabViewContext): void {
    const sessionCtx = ctx as SessionTabContext;
    acpChatResources(sessionCtx.sessionId, sessionCtx.projectId).release(entry.state.sessionId);
  },

  commands: {
    rename: {
      label: 'Rename',
      exec: (resource: AcpChatTabResource, name?: string) => {
        if (name) resource.rename(name);
      },
    },
  },

  TabBarItem: AcpChatTabBarItem,
  TabBarItemDragPreview: AcpChatTabBarItemDragPreview,
  TabContent: registeredTabView('acp-chat'),
});
