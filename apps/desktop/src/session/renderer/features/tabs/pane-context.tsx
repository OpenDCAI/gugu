import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { useScreenBlock } from '@renderer/app/screen-block-context';
import { useTabShortcuts } from './hooks/useTabShortcuts';
import type { Pane } from './pane-layout-store';
import type { PaneStore } from './pane-store';

export interface PaneContextValue {
  paneId: string;
  pane: PaneStore;
  /** True when this pane is the focused pane in the main region. */
  isFocusedPane: boolean;
}

export const PaneContext = createContext<PaneContextValue | null>(null);

/**
 * Returns the per-pane PaneStore and paneId for the enclosing pane.
 * Must be used inside a PaneProvider (i.e. within SplitPaneLayout).
 */
export function usePaneContext(): PaneContextValue {
  const ctx = useContext(PaneContext);
  if (!ctx) {
    throw new Error('usePaneContext must be used within a PaneProvider');
  }
  return ctx;
}

interface PaneProviderProps {
  group: Pane;
  isFocusedPane: boolean;
  children?: ReactNode;
}

/**
 * Wraps a single pane with its PaneContext value.
 * Callers (e.g. SplitPaneLayout) are responsible for composing EditorProvider
 * around the pane content outside this component.
 */
export function PaneProvider({
  group,
  isFocusedPane,
  children,
}: PaneProviderProps) {
  // The tab shortcuts listen on the document, so a retained page that is not on screen must not count
  // as focused — ⌘W would otherwise close the active tab of every retained page at once. With several
  // blocks on the screen (#7052) only the block looked at answers them.
  const shown = useContext(PageShownContext);
  const { focused: blockFocused } = useScreenBlock();
  const focused = isFocusedPane && shown && blockFocused;
  useTabShortcuts(group.pane, { focused });

  // The value must keep its identity across re-renders: every consumer of this context re-renders
  // when the value changes, and this provider sits above a pane whose contents change constantly
  // (a streaming turn, a tab opening). A fresh object per render re-rendered all of them for
  // nothing — most only read `paneId`, which never changes. The three inputs are the whole value.
  const value = useMemo<PaneContextValue>(
    () => ({ paneId: group.paneId, pane: group.pane, isFocusedPane: focused }),
    [group.paneId, group.pane, focused],
  );

  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}
