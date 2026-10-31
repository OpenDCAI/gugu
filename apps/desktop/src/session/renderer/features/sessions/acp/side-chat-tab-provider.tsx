import { GitFork } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import type { ResolvedTab, TabBarItemProps, TabEntry, TabHandle, TabProvider, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { formatSessionTitleForDisplay } from '../session-title-utils';
import { sessionRegistry } from '../stores/session-registry';
import { acpChatResources } from './acp-chat-resources';
import { AcpChatTabResource } from './acp-chat-tab-resource';
import { translateSessionMessage } from '@renderer/localization/locale-store';

export interface SideChatRuntimeView {
  id: string;
  forkFromProviderSessionId: string;
  /** Gugu-owned parent relation; OpenCode's provider session does not persist parentID. */
  forkedFromSessionId: string;
}

export interface SideChatState {
  sessionId: string;
  runtimeView: SideChatRuntimeView;
}

export type SideChatOpenArgs = SideChatState;

function sideChatLabel(resource: AcpChatTabResource): string {
  const session = sessionRegistry
    .get(resource.store.sessionId)
    ?.sessions.get(resource.store.sessionId);
  const baseLabel = session
    ? formatSessionTitleForDisplay(session.data.providerId, session.data.title)
    : 'ACP Chat';
  return translateSessionMessage('chat.sideChatSuffix', { label: baseLabel });
}

const SideChatTabBarItem = observer(function SideChatTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<AcpChatTabResource>) {
  const label = sideChatLabel(tab.resource);
  const runtimeViewId = tab.resource.store.runtimeView?.id;
  const forkedFromSessionId = tab.resource.store.runtimeView?.forkedFromSessionId;

  return (
    <div
      className="h-full shrink-0"
      data-side-chat-runtime-view-id={runtimeViewId}
      data-side-chat-forked-from={forkedFromSessionId}
    >
      <GenericTabItem
        tab={tab}
        host={host}
        ctx={ctx}
        label={label}
        preSlot={<GitFork className="size-3.5 shrink-0 text-foreground-muted" />}
        kindCommands={[]}
      />
    </div>
  );
});

function SideChatTabBarItemDragPreview({ tab }: { tab: ResolvedTab<AcpChatTabResource> }) {
  return (
    <GenericTabDragPreview
      label={sideChatLabel(tab.resource)}
      preSlot={<GitFork className="size-3.5 shrink-0 text-foreground-muted" />}
    />
  );
}

export const sideChatTabProvider: TabProvider<
  'side-chat',
  SideChatState,
  AcpChatTabResource,
  SideChatOpenArgs
> = createTabProvider({
  kind: 'side-chat',
  mount: 'single',
  resourceKey: (state) => state.runtimeView.id,
  isPersistent: () => false,
  onBeforeOpen: (args) => ({
    sessionId: args.sessionId,
    runtimeView: args.runtimeView,
  }),
  initialize(
    entry: TabEntry<SideChatState>,
    _handle: TabHandle,
    ctx: TabViewContext
  ): AcpChatTabResource {
    const sessionCtx = ctx as SessionTabContext;
    const store = acpChatResources(sessionCtx.sessionId, sessionCtx.projectId).acquire(
      entry.state.sessionId,
      entry.state.runtimeView
    );
    return new AcpChatTabResource(store);
  },
  dispose(entry: TabEntry<SideChatState>, _resource, ctx: TabViewContext): void {
    const sessionCtx = ctx as SessionTabContext;
    acpChatResources(sessionCtx.sessionId, sessionCtx.projectId).release(entry.state.runtimeView.id);
  },
  TabBarItem: SideChatTabBarItem,
  TabBarItemDragPreview: SideChatTabBarItemDragPreview,
  TabContent: registeredTabView('side-chat'),
});
