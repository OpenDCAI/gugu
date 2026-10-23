import { Search } from '@/lib/icons'
import { useShowModal } from '@renderer/lib/modal/modal-provider';
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
  const showCommandPalette = useShowModal('commandPaletteModal');
  return (
    // 组离侧栏边多远归 list body(sidebar-primitives 的 sidebarGroupInsetX);内容列与下面那三个
    // 按钮共用 sidebarRowContentInsetX —— 两级都同源,图标才落在同一条竖线上(e2e 3480 ②)。
    // 底色和别处的搜索框同一个输入面(--em-surface-input,#132):它长得就是一个搜索框。
    <button
      type="button"
      onClick={() => showCommandPalette({})}
      aria-label={translate('sidebar.searchConversations')}
      data-testid="sidebar-search-trigger"
      className={cn(
        'group/row flex h-8 w-full items-center gap-2 rounded-full bg-[var(--em-surface-input)] text-sm text-foreground-tertiary-muted',
        sidebarRowContentInsetX
      )}
    >
      <Search className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
      <span className="min-w-0 flex-1 truncate text-left">{translate('sidebar.searchPlaceholder')}</span>
      <BoundShortcut settingsKey="commandPalette" variant="keycaps" className={sidebarRowShortcutClass} />
    </button>
  );
}
