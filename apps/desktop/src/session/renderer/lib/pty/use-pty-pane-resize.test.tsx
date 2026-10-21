import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPaneDimensionSink, type PaneDimensionSink } from '@renderer/features/tabs/pane-dimension-provider';
import { usePtyPaneResize, type PtyPaneResizeControls } from './use-pty-pane-resize';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent = vi.hoisted(() => [] as string[]);
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { pty: { resize: (id: string, cols: number, rows: number) => sent.push(`${id}:${cols}x${rows}`) } },
}));
vi.mock('./pty', () => ({ getFrontendPty: () => undefined, TERMINAL_PADDING_PX: 0 }));

const CELL = { width: 10, height: 20 };
let root: Root;
let controls: PtyPaneResizeControls;

function Pane({ sessionIds, sink }: { sessionIds: string[]; sink: PaneDimensionSink }) {
  controls = usePtyPaneResize(sessionIds, sink);
  return null;
}

/** The resize scheduler coalesces a burst on a trailing timer; let it fire (fake timers — no wall clock). */
const flush = () => act(() => void vi.advanceTimersByTime(1_000));

describe('usePtyPaneResize: a pane whose sessions come and go with different layouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    const dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    root = createRoot(dom.window.document.getElementById('root')!);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a PTY only ever gets the grid measured for its own layout — never the one of the session shown before', () => {
    const sink = createPaneDimensionSink();
    // A: right panel closed, the terminal is 800px wide → 80 columns.
    sink.setDimensions(800, 400);
    act(() => root.render(<Pane sessionIds={['A']} sink={sink} />));
    act(() => controls.calibrateCell(CELL.width, CELL.height));
    flush();
    expect(sent).toEqual(['A:80x20']);

    // Switch to B. At this moment the pane still has A's pixels: nothing may be pushed to B on joining.
    sent.length = 0;
    act(() => root.render(<Pane sessionIds={['B']} sink={sink} />));
    flush();
    expect(sent).toEqual([]);

    // B's layout lands (its right panel is open → 500px), then its terminal calibrates after layout.
    act(() => sink.setDimensions(500, 400));
    act(() => controls.calibrateCell(CELL.width, CELL.height));
    flush();
    expect(new Set(sent)).toEqual(new Set(['B:50x20']));

    // And back to A: A gets its own 80 columns, B is not touched.
    sent.length = 0;
    act(() => root.render(<Pane sessionIds={['A']} sink={sink} />));
    act(() => sink.setDimensions(800, 400));
    act(() => controls.calibrateCell(CELL.width, CELL.height));
    flush();
    expect(new Set(sent)).toEqual(new Set(['A:80x20']));
  });

  it('a session joining a pane whose size did not change still gets the grid, from the calibration after layout', () => {
    const sink = createPaneDimensionSink();
    sink.setDimensions(800, 400);
    act(() => root.render(<Pane sessionIds={['A']} sink={sink} />));
    act(() => controls.calibrateCell(CELL.width, CELL.height));
    flush();
    sent.length = 0;
    act(() => root.render(<Pane sessionIds={['NEW']} sink={sink} />));
    act(() => controls.calibrateCell(CELL.width, CELL.height));
    flush();
    expect(sent).toEqual(['NEW:80x20']);
  });

  it('the observable grid only changes when the grid does (a same-size recompute must not wake the terminals)', () => {
    const sink = createPaneDimensionSink();
    sink.setDimensions(800, 400);
    act(() => root.render(<Pane sessionIds={['A']} sink={sink} />));
    act(() => controls.calibrateCell(CELL.width, CELL.height));
    const before = controls.controllerDims.get();
    act(() => controls.calibrateCell(CELL.width, CELL.height));
    expect(controls.controllerDims.get()).toBe(before);
    act(() => sink.setDimensions(500, 400));
    expect(controls.controllerDims.get()).toEqual({ cols: 50, rows: 20 });
  });
});
