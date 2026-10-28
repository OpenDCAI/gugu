import { observer } from 'mobx-react-lite';
import { ChatDetailsMenuItems } from '@/components/chat/ChatDetailsMenuItems';
import { readChatSummary } from '@/lib/chatSummariesBridge';
import { openApp } from '@/components/appSlot/useOpenApp';
import { openInfoTab } from './chat-tabs/chat-layouts';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { ContextMenuItem, ContextMenuSeparator } from '@renderer/lib/ui/context-menu';

export const chatTabHasActions = (chatId: string) => readChatSummary(chatId)?.kind !== 'group' || installedExtensionsStore.openableApps.length > 0;

/** A group's settings live in its header; its tab keeps Apps, while a DM keeps its own info action. */
export const ChatTabMenuItems = observer(function ChatTabMenuItems({ chatId }: { chatId: string }) {
  const apps = installedExtensionsStore.openableApps;
  const group = readChatSummary(chatId)?.kind === 'group';
  return (
    <>
      {!group && <ChatDetailsMenuItems isGroupChat={false} onOpenInfo={() => openInfoTab(chatId)} />}
      {!group && apps.length > 0 && <ContextMenuSeparator />}
      {apps.map((app) => (
        <ContextMenuItem key={app.extensionId} className="flex items-center gap-2" onClick={() => openApp(app.extensionId, chatId)}>
          {app.iconDataUrl ? <img src={app.iconDataUrl} alt="" className="size-4 rounded-sm" /> : <span className="size-4" />}
          {app.name}
        </ContextMenuItem>
      ))}
    </>
  );
});
