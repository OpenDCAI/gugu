import { observer } from 'mobx-react-lite';
import { ChatDetailsMenuItems } from '@/components/chat/ChatDetailsMenuItems';
import { readChatSummary } from '@/lib/chatSummariesBridge';
import { UI_EVENTS, type ChatDetailsRequest } from '@/lib/uiEvents';
import { openApp } from '@/components/appSlot/useOpenApp';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { ContextMenuItem, ContextMenuSeparator } from '@renderer/lib/ui/context-menu';

/**
 * The tab's context menu shares its conversation actions with More. Requests name
 * the source conversation so only its panel answers; Apps use the same openApp path.
 */
export const ChatTabMenuItems = observer(function ChatTabMenuItems({ chatId }: { chatId: string }) {
  const ask = (page: ChatDetailsRequest['page']) =>
    window.dispatchEvent(new CustomEvent<ChatDetailsRequest>(UI_EVENTS.openChatDetailsDrawer, { detail: { chatId, page } }));
  const apps = installedExtensionsStore.openableApps;
  return (
    <>
      <ChatDetailsMenuItems isGroupChat={readChatSummary(chatId)?.kind === 'group'} onOpenAnnouncement={() => ask('announcement')} onOpenSettings={() => ask('settings')} />
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
