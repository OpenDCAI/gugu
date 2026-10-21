/**
 * usePtyPaneResize — per-pane PTY resize controller.
 *
 * Owns the single source of truth for cols/rows within a pane:
 *   1. Reacts to the pane's observable pixel dimensions (PaneDimensionSink) via MobX.
 *   2. Converts px → cols/rows using the cell size of a live terminal (calibrateCell).
 *   3. Broadcasts rpc.pty.resize to ALL session IDs in the pane (active + background); the
 *      registry in main drops a size the PTY already has.
 *   4. Exposes an observable `controllerDims` box so mounted terminals can call
 *      term.resize() reactively without re-measuring.
 *
 * @@@no-guessed-grid — until a mounted terminal has reported its real cell size there is
 * no grid at all: controllerDims stays null, nothing is broadcast, and a terminal mounts
 * at the grid it already has (the PTY's, see FrontendPty.connect). This controller used
 * to seed itself from its own canvas measurement and re-measure the same way on
 * terminal-font-changed, but that measurement is not xterm's (it rounds the glyph width
 * up: 7.8px → 8px, 120 → 117 columns). The guessed grid reached the terminal — and after
 * a font-ready event the PTY too — for a moment before the real one replaced it, and
 * xterm's reflow through 117 columns is lossy: Claude Code's input box came back split
 * into 117 + 3 (2026-09-25: replaying the same screen through any 120→117→120 detour
 * reproduces it; staying at 120 does not). Font
 * changes are recalibrated by the mounted terminal itself (use-pty's font handler).
 *
 * Must be called inside a PaneDimensionProvider so the sink is available.
 */

import type { IObservableValue } from 'mobx';
import { observable, reaction, runInAction } from 'mobx';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PaneDimensionSink } from '@renderer/features/tabs/pane-dimension-provider';
import { rpc } from '@renderer/lib/ipc';
import { getFrontendPty, TERMINAL_PADDING_PX } from './pty';
import { computeGridDimensions } from './pty-dimensions';
import { createResizeScheduler, type ResizeScheduler } from './resize-scheduler';

const PTY_RESIZE_DEBOUNCE_MS = 60;

export interface PtyPaneResizeControls {
  /**
   * Observable box tracking the current cols/rows computed by the controller.
   * Mounted terminals subscribe to this to keep their xterm grid in sync without
   * re-measuring themselves.
   */
  controllerDims: IObservableValue<{ cols: number; rows: number } | null>;
  /**
   * Called by a mounted terminal with its exact CSS cell dimensions.
   * Updates the controller's cell size and triggers an immediate recompute
   * so the grid and backend stay in lockstep with the correct measurements.
   */
  calibrateCell(width: number, height: number): void;
}

export function usePtyPaneResize(
  sessionIds: string[],
  sink: PaneDimensionSink | null,
  bottomPadding = 0
): PtyPaneResizeControls {
  const sessionsRef = useRef<string[]>([]);

  // ── Observable controller dims box (stable across renders) ──────────────────
  const controllerDimsBoxRef =
    useRef<IObservableValue<{ cols: number; rows: number } | null>>(null);
  if (controllerDimsBoxRef.current === null) {
    controllerDimsBoxRef.current = observable.box<{ cols: number; rows: number } | null>(null);
  }
  const controllerDims = controllerDimsBoxRef.current;

  // ── Cell size: only ever from a live terminal (calibrateCell), see @@@no-guessed-grid ──
  const cellSizeRef = useRef<{ width: number; height: number } | null>(null);

  // ── Broadcast scheduler ─────────────────────────────────────────────────────
  const schedulerRef = useRef<ResizeScheduler<{ cols: number; rows: number }> | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = createResizeScheduler((dims) => {
      for (const id of sessionsRef.current) {
        void rpc.pty.resize(id, dims.cols, dims.rows);
        const term = getFrontendPty(id)?.terminal;
        if (term && (term.cols !== dims.cols || term.rows !== dims.rows)) {
          term.resize(dims.cols, dims.rows);
        }
      }
    }, PTY_RESIZE_DEBOUNCE_MS);
  }

  // ── Core recompute ──────────────────────────────────────────────────────────
  // Converts the pane's pixel dimensions + current cell size → cols/rows,
  // updates the observable box, and schedules a backend broadcast.
  const sinkRef = useRef<PaneDimensionSink | null>(sink);
  sinkRef.current = sink;

  // bottomPadding may change when e.g. a ContextBar appears/disappears.
  const bottomPaddingRef = useRef(bottomPadding);
  bottomPaddingRef.current = bottomPadding;

  const recompute = useCallback(() => {
    const currentSink = sinkRef.current;
    const cell = cellSizeRef.current;
    const pixelDims = currentSink?.dimensions;
    if (!cell || !pixelDims) return;

    // The provider measures the content region (TabBar excluded). The uniform
    // TERMINAL_PADDING_PX insets the terminal from all sides; bottomPadding
    // adds an extra bottom inset for chrome rendered inside the content region
    // (e.g. the conversations ContextBar).
    const dims = computeGridDimensions({
      widthPx: pixelDims.width,
      heightPx: pixelDims.height,
      cellWidth: cell.width,
      cellHeight: cell.height,
      paddingPx: TERMINAL_PADDING_PX,
      padding: { bottom: bottomPaddingRef.current },
    });
    if (!dims) return;

    const box = controllerDimsBoxRef.current!;
    const prev = box.get();
    if (prev?.cols !== dims.cols || prev.rows !== dims.rows) {
      runInAction(() => box.set(dims));
    }
    schedulerRef.current?.schedule(dims);
  }, []);

  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;

  // ── MobX reaction: recompute when pane pixel dimensions change ───────────────
  // Runs synchronously within the ResizeObserver callback (MobX action → reaction),
  // preserving the "resize before next paint" guarantee (ENG-1577).
  useEffect(() => {
    if (!sink) return;
    const dispose = reaction(
      () => sink.dimensions,
      () => recomputeRef.current()
    );
    // Fire immediately if we already have dimensions.
    if (sink.dimensions) recomputeRef.current();
    return dispose;
    // `sink` identity only changes when PaneSizingContextProvider re-mounts.
     
  }, [sink]);

  // ── Recompute when bottomPadding changes ────────────────────────────────────
  // The shared measurement does not change when chrome inside the content region
  // (e.g. ContextBar) appears/disappears, so we need an explicit recompute
  // triggered by the padding change rather than a ResizeObserver event.
  const prevBottomPaddingRef = useRef(bottomPadding);
  useEffect(() => {
    if (prevBottomPaddingRef.current !== bottomPadding) {
      prevBottomPaddingRef.current = bottomPadding;
      recomputeRef.current();
    }
  }, [bottomPadding]);

  // ── Session IDs ─────────────────────────────────────────────────────────────
  // A session joining the pane gets nothing pushed here: what the controller holds at this moment was
  // measured for the layout of the session shown before (see @@@own-grid-on-mount in use-pty). Its
  // mounted terminal calibrates once layout has settled, and that recompute sends the grid if needed.
  useEffect(() => {
    sessionsRef.current = sessionIds;
  }, [sessionIds]);

  // ── Cancel pending flush on unmount ─────────────────────────────────────────
  useEffect(() => {
    return () => schedulerRef.current?.cancel();
  }, []);

  // ── Public API ──────────────────────────────────────────────────────────────
  // Recomputes even when the cell size is unchanged: a terminal calibrating after it mounted is how a
  // session that just joined the pane gets the grid of this layout (no-op when nothing differs).
  const calibrateCell = useCallback((width: number, height: number) => {
    cellSizeRef.current = { width, height };
    recomputeRef.current();
  }, []);

  return useMemo(() => ({ controllerDims, calibrateCell }), [controllerDims, calibrateCell]);
}
