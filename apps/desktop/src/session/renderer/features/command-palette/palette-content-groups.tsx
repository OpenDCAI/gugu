import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { MessageSquare, Users } from '@/lib/icons';
import { useChatSummaries } from '@/lib/chatSummariesBridge';
import { followLink } from '@/lib/guguLinks';
import { chatDb } from '@/lib/supabase';
import { UI_EVENTS } from '@/lib/uiEvents';
import { askTaskReveal } from '@/hooks/useSourceMessageReveal';
import { conversationLink } from '@gugu/core/shared/ui/guguLink';
import { messageQuoteLink } from '@gugu/core/shared/ui/messageQuote';
import { excerpt } from '@shared/core/search';
import { rpc } from '@renderer/lib/ipc';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';

/** What the palette searches inside: everything, what was said in local tasks, or IM messages in every chat. */
export type PaletteScope = 'all' | 'taskContent' | 'messages';

type MessageHit = { id: string; chat_id: string; sender_name: string; content: string | null };

/** Task content and message hits for a typed query; `limit` is smaller when they share the list with names. */
export function PaletteContentGroups({ query, scope, groupClassName, onClose }: {
  query: string; scope: PaletteScope; groupClassName: string; onClose: () => void;
}) {
  const { translate } = useSessionMessages();
  const chats = useChatSummaries();
  const limit = scope === 'all' ? 5 : 30;
  const turns = useQuery({
    queryKey: ['cmdk-task-turns', query],
    queryFn: () => rpc.search.taskTurns({ query }),
    enabled: !!query && scope !== 'messages',
    staleTime: 5_000,
  });
  const messages = useQuery({
    queryKey: ['cmdk-messages', query, limit],
    queryFn: async () => {
      const { data, error } = await chatDb.rpc('message_search_as', { p_chat_id: null, p_query: query, p_limit: limit });
      if (error) throw new Error(error.message);
      return data as MessageHit[];
    },
    enabled: !!query && scope !== 'taskContent',
    staleTime: 5_000,
  });
  if (!query) return null;
  const turnHits = scope === 'messages' ? [] : (turns.data ?? []).slice(0, limit);
  const messageHits = scope === 'taskContent' ? [] : messages.data ?? [];
  return (
    <>
      {turnHits.length > 0 && (
        <Command.Group heading={translate('palette.taskContent')} className={groupClassName}>
          {turnHits.map((hit) => (
            <Command.Item key={`${hit.sessionId}:${hit.itemId}`} value={`turn:${hit.sessionId}:${hit.itemId}`} className={PALETTE_ITEM_CLASS}
              onSelect={() => {
                onClose();
                askTaskReveal(hit.sessionId, messageQuoteLink({ kind: 'session', sessionId: hit.sessionId, itemId: hit.itemId }));
                followLink({ kind: 'session', sessionId: hit.sessionId, projectId: hit.projectId });
                window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked));
              }}>
              <MessageSquare size={14} className="shrink-0 text-foreground/40" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{hit.excerpt}</span>
                <span className="block truncate text-xs text-foreground/40">{hit.title}</span>
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
      {messages.error && scope !== 'taskContent' && (
        <div role="alert" className="px-2 py-1 text-xs text-destructive">{messages.error.message}</div>
      )}
      {messageHits.length > 0 && (
        <Command.Group heading={translate('palette.messages')} className={groupClassName}>
          {messageHits.map((hit) => (
            <Command.Item key={hit.id} value={`message:${hit.id}`} className={PALETTE_ITEM_CLASS}
              onSelect={() => { onClose(); followLink(conversationLink(hit.chat_id, hit.id)); }}>
              <Users size={14} className="shrink-0 text-foreground/40" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{excerpt(hit.content ?? '', query)}</span>
                <span className="block truncate text-xs text-foreground/40">
                  {[chats.get(hit.chat_id)?.name, hit.sender_name].filter(Boolean).join(' · ')}
                </span>
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
    </>
  );
}
