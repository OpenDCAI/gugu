import { observer } from 'mobx-react-lite';
import { ChatDetailsMenuItems } from '@/components/chat/ChatDetailsMenuItems';
import { readChatSummary } from '@/lib/chatSummariesBridge';
import { openApp } from '@/components/appSlot/useOpenApp';
import { openInfoTab } from './chat-tabs/chat-layouts';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { ContextMenuItem, ContextMenuSeparator } from '@renderer/lib/ui/context-menu';

/** The tab's context menu: the chat's info (its own tab, opened in this chat's strip), then its Apps by the same openApp path. */
export const ChatTabMenuItems = observer(function ChatTabMenuItems({ chatId }: { chatId: string }) {
  const apps = installedExtensionsStore.openableApps;
  return (
    <>
      <ChatDetailsMenuItems isGroupChat={readChatSummary(chatId)?.kind === 'group'} onOpenInfo={() => openInfoTab(chatId, readChatSummary(chatId)?.kind === 'group' ? 'main' : undefined)} />
      {apps.length > 0 && <ContextMenuSeparator />}
      {apps.map((app) => (
        <ContextMenuItem key={app.extensionId} className="flex items-center gap-2" onClick={() => openApp(app.extensionId, chatId)}>
          {app.iconDataUrl ? <img src={app.iconDataUrl} alt="" className="size-4 rounded-sm" /> : <span className="size-4" />}
          {app.name}
        </ContextMenuItem>
      ))}
    </>
  );
});
