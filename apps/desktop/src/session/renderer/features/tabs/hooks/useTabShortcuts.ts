import { useHotkey } from '@tanstack/react-hotkeys';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { TAB_NAVIGATION_HOTKEYS } from '@shared/shortcuts';

/**
 * Minimal interface required for tab navigation shortcuts.
 * Both PaneStore and EditorViewStore satisfy this shape.
 */
export interface TabNavigationProvider {
  setNextTabActive: () => void;
  setPreviousTabActive: () => void;
  setTabActiveIndex: (index: number) => void;
  closeActiveTab: () => void;
  reopenClosedTab?: () => void;
  /** Triggers inline rename of the active tab. Returns true when handled. */
  renameActiveTab?: () => boolean;
}

export interface UseTabShortcutsOptions {
  /**
   * When false, all tab shortcuts are disabled. Use this to scope shortcuts
   * to a specific panel so they only fire when that panel is focused.
   * Defaults to true (always enabled when store is present).
   */
  focused?: boolean;
}

/** The focused pane owns both palette actions and their configurable keys. */
export function useTabShortcuts(store: TabNavigationProvider | undefined, options?: UseTabShortcutsOptions): void {
  const enabled = !!store && (options?.focused ?? true);
  useCommandProvider({
    scopeId: 'session-sub',
    getCommands: () => !enabled || !store ? [] : [
      { id: 'session.tabNext', execute: () => store.setNextTabActive() },
      { id: 'session.tabPrev', execute: () => store.setPreviousTabActive() },
      { id: 'session.tabClose', execute: () => store.closeActiveTab() },
      { id: 'session.tabReopen', execute: () => { store.reopenClosedTab?.(); } },
      { id: 'session.tabRename', enabled: !!store.renameActiveTab, execute: () => { store.renameActiveTab?.(); } },
      ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => ({
        id: `session.tab${n}` as const, execute: () => store.setTabActiveIndex(n - 1),
      })),
    ],
  });
  useHotkey(TAB_NAVIGATION_HOTKEYS.next, () => store?.setNextTabActive(), { enabled, conflictBehavior: 'allow' });
  useHotkey(TAB_NAVIGATION_HOTKEYS.previous, () => store?.setPreviousTabActive(), { enabled, conflictBehavior: 'allow' });
}
