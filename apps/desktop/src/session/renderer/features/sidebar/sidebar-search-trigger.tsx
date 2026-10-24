import { Search } from '@/lib/icons'
import { commandRegistry } from '@renderer/lib/commands/registry';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { sidebarRowContentInsetX, sidebarRowShortcutClass } from './sidebar-primitives';

/**
 * 侧栏顶上的「搜索…」:点它和按 ⌘K 一样,打开那一个面板(gugu-dev#181 ⑯:会话、项目、对话、话题和操作一次搜)。
 * 侧栏自己不再就地筛 —— 搜索只有一个地方。
 */
export function SidebarSearchTrigger() {
  const { translate } = useSessionMessages();
  return (
    // The header owns placement; reuse the existing search surface and content inset.
    // 底色和别处的搜索框同一个输入面(--em-surface-input,#132):它长得就是一个搜索框。
    <button
      type="button"
      onClick={() => commandRegistry.dispatch('app.quickSwitcher')}
      aria-label={translate('sidebar.searchConversations')}
      data-testid="sidebar-search-trigger"
      className={cn(
        'group/row flex h-8 min-w-0 w-full items-center gap-2 rounded-full bg-[var(--em-surface-input)] text-sm text-foreground-tertiary-muted [-webkit-app-region:no-drag]',
        sidebarRowContentInsetX
      )}
    >
      <Search className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
      <span className="min-w-0 flex-1 truncate text-left">{translate('sidebar.searchPlaceholder')}</span>
      <BoundShortcut commandId="app.quickSwitcher" variant="keycaps" className={sidebarRowShortcutClass} />
    </button>
  );
}
