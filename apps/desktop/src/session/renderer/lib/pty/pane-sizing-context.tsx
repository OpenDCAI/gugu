/**
 * PaneSizingContext — PTY sizing bridge for a pane.
 *
 * Reads the nearest PaneDimensionProvider (mounted by SplitPane) and drives a
 * single per-pane resize controller shared across all terminals in the pane.
 * Consumed by use-pty.ts via usePaneSizingContext().
 *
 * The controller (usePtyPaneResize) owns:
 *   - Converting pane pixel dimensions → cols/rows
 *   - Broadcasting rpc.pty.resize to ALL sessions (active + background)
 *   - Exposing an observable controllerDims box so mounted terminals can call
 *     term.resize() reactively without re-measuring themselves
 */

import type { IObservableValue } from 'mobx';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { usePaneDimensions } from '@renderer/features/tabs/pane-dimension-provider';
import { usePtyPaneResize } from './use-pty-pane-resize';

// ── Context interface ─────────────────────────────────────────────────────────

export interface PaneSizingContextValue {
  /**
   * Observable box: the current cols/rows computed by the per-pane controller.
   * Mounted terminals subscribe to this to resize their xterm grid without
   * re-measuring themselves.
   */
  controllerDims: IObservableValue<{ cols: number; rows: number } | null>;
  /**
   * Called by a mounted terminal with its exact CSS cell dimensions.
   * Refines the controller's cell size for accurate cols/rows computation.
   */
  calibrateCell(width: number, height: number): void;
}

const PaneSizingContext = createContext<PaneSizingContextValue | null>(null);

export function usePaneSizingContext(): PaneSizingContextValue | null {
  return useContext(PaneSizingContext);
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function PaneSizingContextProvider({
  ptySessionIds,
  bottomPadding = 0,
  children,
}: {
  ptySessionIds: string[];
  /**
   * Extra bottom inset (px) subtracted from the measured content height before
   * the grid calculation. Use this to account for chrome that sits inside the
   * measured region but below the terminal (e.g. the conversations ContextBar).
   */
  bottomPadding?: number;
  children: ReactNode;
}) {
  const dims = usePaneDimensions();
  const sink = dims?.sink ?? null;

  const { controllerDims, calibrateCell } = usePtyPaneResize(
    ptySessionIds,
    sink,
    bottomPadding
  );

  const value = useMemo<PaneSizingContextValue | null>(() => {
    if (!dims) return null;
    return { controllerDims, calibrateCell };
  }, [dims, controllerDims, calibrateCell]);

  return <PaneSizingContext.Provider value={value}>{children}</PaneSizingContext.Provider>;
}
