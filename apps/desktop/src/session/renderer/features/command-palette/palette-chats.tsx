import { Command } from 'cmdk';
import { MessageSquare, MessageSquareShare, Users } from '@/lib/icons';
import { useChatSummaries, type ChatSummary } from '@/lib/chatSummariesBridge';
import { openConversationLink } from '@/lib/conversationLinks';
import { conversationLink } from '@gugu/core/shared/ui/conversationLink';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';

/**
 * gugu-dev#181 ⑯ ⌘K 面板里的「对话」和「话题」:壳发过来的那份对话摘要(chatSummariesBridge)按名字和最后一句就地筛 ——
 * 一个 ⌘K 一次搜到会话、项目、对话和话题,❌ 另起一套搜索。项目群不在这里(它在「项目」里,项目就是群)。
 * 话题这一版只搜名字和最后一句,不搜话题里的每一条消息。
 */
export function PaletteChatGroups({ query, groupClassName, onClose }: {
  query: string;
  groupClassName: string;
  onClose: () => void;
}) {
  const { translate } = useSessionMessages();
  const summaries = useChatSummaries();
  const q = query.trim().toLowerCase();
  const has = (summary: ChatSummary) =>
    !q || [summary.name, summary.lastMessagePreview].some((text) => text?.toLowerCase().includes(q));
  const listed = [...summaries].filter(([id]) => !projectGroupsStore.projectOfChat(id));
  const chats = listed.filter(([, summary]) => summary.kind !== 'topic' && summary.name && has(summary)).slice(0, q ? 8 : 5);
  const topics = q ? listed.filter(([, summary]) => summary.kind === 'topic' && has(summary)) : [];
  // 与点一条对话链接同一条路(壳的 openChatBlock:话题 = 它的源对话 + 话题分栏,项目群开项目块)。
  const bringUp = (chatId: string) => {
    onClose();
    openConversationLink(conversationLink(chatId));
  };
  const nameOf = (chatId: string | null) => (chatId ? summaries.get(chatId)?.name ?? '' : '');
  return (
    <>
      {chats.length > 0 && (
        <Command.Group heading={translate(q ? 'palette.chats' : 'palette.recentChats')} className={groupClassName}>
          {chats.map(([id, summary]) => {
            const Icon = summary.kind === 'group' ? Users : MessageSquare;
            // 搜到的是最后一句(名字没中):把那一句写在后面;否则写是群聊还是私聊。
            const sub = q && !summary.name?.toLowerCase().includes(q)
              ? summary.lastMessagePreview
              : translate(summary.kind === 'group' ? 'palette.groupChat' : 'palette.directChat');
            return (
              <Command.Item key={id} value={`chat:${id}`} onSelect={() => bringUp(id)} className={PALETTE_ITEM_CLASS}>
                <Icon size={14} className="shrink-0 text-foreground/40" />
                <span className="flex-1 truncate">{summary.name}</span>
                {sub ? <span className="max-w-[45%] truncate text-xs text-foreground/40">{sub}</span> : null}
              </Command.Item>
            );
          })}
        </Command.Group>
      )}
      {topics.length > 0 && (
        <Command.Group heading={translate('palette.topics')} className={groupClassName}>
          {topics.map(([id, summary]) => (
            <Command.Item key={id} value={`topic:${id}`} onSelect={() => bringUp(id)} className={PALETTE_ITEM_CLASS}>
              <MessageSquareShare size={14} className="shrink-0 text-foreground/40" />
              <span className="flex-1 truncate">{summary.name}</span>
              <span className="max-w-[45%] truncate text-xs text-foreground/40">
                {translate('palette.topicIn', { name: nameOf(summary.sourceChatId) })}
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
    </>
  );
}
