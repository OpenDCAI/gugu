import { observer } from 'mobx-react-lite';
import { Bell, Settings } from '@/lib/icons';
import { readChatSummary } from '@/lib/chatSummariesBridge';
import { UI_EVENTS, type ChatDetailsRequest } from '@/lib/uiEvents';
import { openApp } from '@/components/appSlot/useOpenApp';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { ContextMenuItem, ContextMenuSeparator } from '@renderer/lib/ui/context-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * 块第一枚页签右键菜单里这个对话的那几行(gugu-dev#181:页签条右端没有 ⋯,原来 ⋯ 里的东西都在这里):
 * 群公告(群才有)、设置、在本群打开 App。公告和设置是壳那块面上的抽屉,点名对话发过去(只有那块面答);
 * App 走「在本群打开」同一条 openApp。
 */
export const ChatTabMenuItems = observer(function ChatTabMenuItems({ chatId }: { chatId: string }) {
  const { translate } = useSessionMessages();
  const ask = (page: ChatDetailsRequest['page']) =>
    window.dispatchEvent(new CustomEvent<ChatDetailsRequest>(UI_EVENTS.openChatDetailsDrawer, { detail: { chatId, page } }));
  const apps = installedExtensionsStore.openableApps;
  return (
    <>
      {readChatSummary(chatId)?.kind === 'group' && (
        <ContextMenuItem className="flex items-center gap-2" onClick={() => ask('announcement')}>
          <Bell className="size-4" />
          {translate('tabMenu.announcement')}
        </ContextMenuItem>
      )}
      <ContextMenuItem className="flex items-center gap-2" onClick={() => ask('settings')}>
        <Settings className="size-4" />
        {translate('tabMenu.settings')}
      </ContextMenuItem>
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
