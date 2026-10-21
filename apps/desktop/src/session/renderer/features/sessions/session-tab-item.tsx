import { observer } from 'mobx-react-lite';
import type { TabBarItemProps, ResolvedTab } from '@renderer/features/tabs/core/tab-provider';
import {
  GenericTabDragPreview,
  GenericTabItem,
} from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { MAX_SESSION_TITLE_LENGTH } from '@shared/core/sessions/sessions';
import type { SessionTabResource } from './session-tab-resource';
import { formatSessionTitleForDisplay } from './session-title-utils';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useSessionTabCommands } from './view/session-actions';

export const SessionTabBarItem = observer(function SessionTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<SessionTabResource>) {
  const { translate } = useSessionMessages();
  const store = tab.resource.store;
  const title = store
    ? formatSessionTitleForDisplay(store.data.providerId, store.data.title)
    : translate('chat.loading');
  const rawTitle = store?.data.title ?? '';
  // 会话的名字在这枚页签上,它的动作(置顶 / 重命名 / 重启 / 换展示 / 归档)就在它的右键里(#7052)。
  const sessionCommands = useSessionTabCommands(tab.resource.sessionId, () => host.requestRename(tab.tabId));

  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={title}
      preSlot={store ? <AgentIcon id={store.data.providerId} size={16} /> : undefined}
      statusSlot={
        store ? <AgentStatusIndicator status={store.indicatorStatus} detail={store.detail} disableTooltip /> : undefined
      }
      kindCommands={
        sessionCommands.length > 0
          ? sessionCommands
          : [
              {
                id: 'session:rename',
                label: 'Rename',
                group: 'edit',
                shortcut: 'tabRename',
                run: () => host.requestRename(tab.tabId),
              },
            ]
      }
      renameValue={rawTitle}
      renameMaxLength={MAX_SESSION_TITLE_LENGTH}
    />
  );
});

export const SessionTabBarItemDragPreview = observer(
  function SessionTabBarItemDragPreview({
    tab,
  }: {
    tab: ResolvedTab<SessionTabResource>;
  }) {
    const { translate } = useSessionMessages();
    const store = tab.resource.store;
    const label = store
      ? formatSessionTitleForDisplay(store.data.providerId, store.data.title)
      : translate('chat.loading');
    return (
      <GenericTabDragPreview
        preSlot={
          store?.data.providerId ? (
            <AgentIcon id={store.data.providerId} size={16} className="shrink-0" />
          ) : undefined
        }
        label={label}
      />
    );
  }
);
