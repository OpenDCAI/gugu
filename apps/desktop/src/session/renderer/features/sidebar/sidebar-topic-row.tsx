import { MessageSquare } from '@/lib/icons';
import type { SidebarTopicLine } from '@/lib/sidebarChatsBridge';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { sessionpageMessageHost } from '@renderer/lib/sessionpage-message-host';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SidebarUnreadCount } from './sidebar-list-switch';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';
import { sidebarRowContentInsetPx } from './sidebar-row-metrics';

// gugu-dev#181 项目就是群:项目群的话题挂在项目行底下,和会话行一样缩进一级。点一行 = 项目块里把这个话题开成分栏,
// 「更多 · N」= 打开这个群的「历史 → 话题」(那条线全部话题的主场);两样都要壳那棵树的请求盒子,所以经消息宿主。

const inset = { paddingLeft: sidebarRowContentInsetPx('tree') };

export function SidebarTopicRow({ topic }: { topic: SidebarTopicLine }) {
  return (
    <SidebarMenuRow className="group/row flex h-8 items-center gap-2 pr-2" style={inset} data-sidebar-topic={topic.id}>
      <SidebarMenuAction className="gap-2" aria-label={topic.name} onClick={() => sessionpageMessageHost().openTopic(topic.id)}>
        <MessageSquare className="size-3.5 shrink-0 text-foreground-passive" />
        <span className="truncate">{topic.name}</span>
      </SidebarMenuAction>
      <SidebarUnreadCount count={topic.unread} />
    </SidebarMenuRow>
  );
}

export function SidebarTopicsMoreRow({ projectId, count }: { projectId: string; count: number }) {
  const { translate } = useSessionMessages();
  const label = translate('sidebar.moreTopics', { count });
  const open = () => {
    const groupChatId = projectGroupsStore.chatIdOf(projectId);
    if (!groupChatId) throw new Error(`project ${projectId} has no group`);
    sessionpageMessageHost().openTopics(groupChatId);
  };
  return (
    <SidebarMenuRow className="group/row flex h-8 items-center" style={inset}>
      <SidebarMenuAction aria-label={label} className="text-foreground-passive" onClick={open}>
        {label}
      </SidebarMenuAction>
    </SidebarMenuRow>
  );
}
