import { useEffect, type ReactNode } from 'react';
import { useChatSummaries } from '@/lib/chatSummariesBridge';
import { isOwnedAgentPeer, openOwnedAgentEntry, useOwnedAgentEntries } from '@/lib/ownedAgentConversation';

/** Old screen/history blocks cannot recreate the owned agent's IM pane or its resource slots. */
export function OwnedAgentChatBoundary({ chatId, children }: { chatId: string; children: ReactNode }) {
  const ready = useOwnedAgentEntries();
  const chat = useChatSummaries().get(chatId);
  const privateChat = chat?.kind === 'dm' || chat?.kind === 'ai';
  const owned = privateChat && isOwnedAgentPeer(chat.peerUserId);
  useEffect(() => { if (owned) openOwnedAgentEntry(chatId); }, [chatId, owned]);
  if (!chat || (privateChat && !ready) || owned) return null;
  return children;
}
