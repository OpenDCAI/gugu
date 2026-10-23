import { JSDOM } from 'jsdom';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { createPaneDimensionSink, PaneDimensionProvider } from '@renderer/features/tabs/pane-dimension-provider';
import { PaneSizingContextProvider } from './pane-sizing-context';
import type { FrontendPty } from './pty';
import { usePty } from './use-pty';

const resize = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { pty: { resize }, appSettings: { get: async () => ({}) } },
  events: { on: () => () => {} },
}));
vi.mock('@renderer/lib/hotkeys/dispatch-matching-hotkeys', () => ({ dispatchMatchingHotkeys: () => false }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./pty', () => ({ getFrontendPty: () => undefined, TERMINAL_PADDING_PX: 0 }));

let root: Root;
let dom: JSDOM;
let pty: FrontendPty;
let hostSize: number[];
const sink = createPaneDimensionSink();

function TerminalPane() {
  const container = useRef<HTMLDivElement>(null);
  usePty({ ptySessionId: 'remote-task', pty }, container);
  return <div ref={container} />;
}

async function show(shown: boolean) {
  await act(async () => root.render(
    <PageShownContext.Provider value={shown}>
      <PaneDimensionProvider sink={sink}>
        <PaneSizingContextProvider ptySessionIds={['remote-task']}>
          <TerminalPane />
        </PaneSizingContextProvider>
      </PaneDimensionProvider>
    </PageShownContext.Provider>
  ));
  await act(async () => vi.advanceTimersByTime(1_000));
}

async function focus(target: EventTarget, type: string) {
  await act(async () => { target.dispatchEvent(new dom.window.Event(type, { bubbles: type === 'focusin' })); });
  await act(async () => vi.advanceTimersByTime(1_000));
}

describe('terminal activation reasserts the visible pane grid', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const ownedContainer = document.createElement('div');
    pty = {
      ownedContainer,
      terminal: {
        cols: 100, rows: 30, options: {},
        _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } },
        attachCustomKeyEventHandler() {},
        onSelectionChange: () => ({ dispose() {} }),
        resize() {},
      },
      mount: (target: HTMLElement) => target.appendChild(ownedContainer),
      unmount: () => ownedContainer.remove(),
      attachInputHandler: () => () => {},
      setTheme() {}, setShown() {},
    } as unknown as FrontendPty;
    hostSize = [];
    resize.mockReset().mockImplementation((_id: string, cols: number, rows: number) => { hostSize = [cols, rows]; });
    sink.setDimensions(1_000, 600);
    root = createRoot(document.getElementById('root')!);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it('restores a retained page after the host grid changed, with identical pane pixels', async () => {
    await show(true);
    expect(hostSize).toEqual([100, 30]);
    await show(false);
    hostSize = [80, 24];
    await show(true);
    expect(hostSize).toEqual([100, 30]);
  });

  it.each(['terminal', 'window'])('restores the host grid when the %s receives focus', async (target) => {
    await show(true);
    hostSize = [80, 24];
    await focus(target === 'terminal' ? pty.ownedContainer : window, target === 'terminal' ? 'focusin' : 'focus');
    expect(hostSize).toEqual([100, 30]);
  });

  it('does not let a hidden page resize its host on window focus', async () => {
    await show(true);
    await show(false);
    resize.mockClear();
    await focus(window, 'focus');
    expect(resize).not.toHaveBeenCalled();
  });
});
