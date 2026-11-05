import { observer } from 'mobx-react-lite';
import { ChatDetailsMenuItems } from '@/components/chat/ChatDetailsMenuItems';
import { readChatSummary } from '@/lib/chatSummariesBridge';
import { openInfoTab } from './chat-tabs/chat-layouts';

export const chatTabHasActions = (chatId: string) => readChatSummary(chatId)?.kind !== 'group';

/** A group's settings live in its header and its Apps behind the strip's「+」, so its tab has no menu; a DM keeps its info action. */
export const ChatTabMenuItems = observer(function ChatTabMenuItems({ chatId }: { chatId: string }) {
  return <ChatDetailsMenuItems isGroupChat={false} onOpenInfo={() => openInfoTab(chatId)} />;
});
