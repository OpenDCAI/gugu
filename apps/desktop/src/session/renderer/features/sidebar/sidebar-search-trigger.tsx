import { Search, X } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { sidebarRowContentInsetX, sidebarRowShortcutClass } from './sidebar-primitives';

/**
 * Focus registry for the sidebar search input, so the ⌘K handler (app-keyboard-shortcuts /
 * the web menu-event path) can focus it from outside the component tree (spec 链8).
 */
export const sidebarSearchFocus: { current: (() => void) | null } = { current: null };

// spec session-page 链8: the sidebar search is an IN-PLACE instant filter over conversation
// titles — typing narrows the list live (section counts follow), clearing restores it,
// ⌘K focuses this box. The command palette stays reachable (⌘P / menu) but is not this row.
export const SidebarSearchInput = observer(function SidebarSearchInput() {
  const { translate } = useSessionMessages();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    sidebarSearchFocus.current = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    return () => {
      sidebarSearchFocus.current = null;
    };
  }, []);

  const query = sidebarStore.searchQuery;

  return (
    // 组离侧栏边多远归 list body(sidebar-primitives 的 sidebarGroupInsetX);内容列与下面那三个
    // 按钮共用 sidebarRowContentInsetX —— 两级都同源,图标才落在同一条竖线上(e2e 3480 ②)。
    // 悬浮/正在搜都走全局那条阶梯(--hover / --selected),与侧栏的行、菜单项同深度;
    // ❌ 别在这里挑 background-1 / background-tertiary-1 之类的容器色 —— 各挑各的,
    // 正是这一组读起来「不是一套」的那一半原因。
    // 「正在搜」是持续状态,所以取 selected 档(比悬浮深一级);此时再悬浮就叠一层,不替换。
    <div
      className={cn(
        'group/row flex h-8 w-full items-center gap-2 rounded-full text-sm transition-colors hover:bg-row-hover focus-within:bg-row-selected focus-within:hover:bg-row-selected focus-within:hover:state-hover-layer',
        sidebarRowContentInsetX
      )}
    >
      <Search className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => sidebarStore.setSearchQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            sidebarStore.setSearchQuery('');
            inputRef.current?.blur();
          }
        }}
        placeholder={translate('sidebar.searchPlaceholder')}
        aria-label={translate('sidebar.searchConversations')}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-foreground-tertiary-muted"
      />
      {query ? (
        <button
          type="button"
          aria-label={translate('sidebar.clearSearch')}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-tertiary-passive hover:text-foreground"
          onClick={() => {
            sidebarStore.setSearchQuery('');
            inputRef.current?.focus();
          }}
        >
          <X className="size-3.5" />
        </button>
      ) : (
        <BoundShortcut
          settingsKey="commandPalette"
          variant="keycaps"
          className={sidebarRowShortcutClass}
        />
      )}
    </div>
  );
});
