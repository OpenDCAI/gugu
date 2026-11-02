import { Search } from '@/lib/icons'
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { openGlobalSearch } from '@renderer/features/global-search/search-session';
import { sidebarRowContentInsetX, sidebarRowShortcutClass } from './sidebar-primitives';

/**
 * 侧栏顶上的「搜索…」:打开搜索面板(搜聊天和任务里说过的话,Mod+Shift+F 同一个)。按名字跳转是 Mod+O,
 * 它的最后一行把打的字交给这里 —— 两个入口,各管一件事。
 */
export function SidebarSearchTrigger() {
  const { translate } = useSessionMessages();
  return (
    // The header owns placement; reuse the existing search surface and content inset.
    // 底色和别处的搜索框同一个输入面(--em-surface-input,#132):它长得就是一个搜索框。
    <button
      type="button"
      onClick={() => openGlobalSearch()}
      aria-label={translate('sidebar.searchConversations')}
      data-testid="sidebar-search-trigger"
      className={cn(
        'group/row flex h-8 min-w-0 w-full items-center gap-2 rounded-full bg-[var(--em-surface-input)] text-sm text-foreground-tertiary-muted [-webkit-app-region:no-drag]',
        sidebarRowContentInsetX
      )}
    >
      <Search className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
      <span className="min-w-0 flex-1 truncate text-left">{translate('sidebar.searchPlaceholder')}</span>
      <BoundShortcut commandId="app.globalSearch" variant="keycaps" className={sidebarRowShortcutClass} />
    </button>
  );
}
