import { JSDOM } from 'jsdom';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { createPaneDimensionSink, PaneDimensionProvider } from '@renderer/features/tabs/pane-dimension-provider';
import { PaneSizingContextProvider } from './pane-sizing-context';
import type { FrontendPty } from './pty';
import { usePty } from './use-pty';
import { notifyPtyOutput } from '../session-output-observers';

const resize = vi.hoisted(() => vi.fn());
const eventOn = vi.hoisted(() => vi.fn());
const sendInput = vi.hoisted(() => vi.fn());
vi.mock('./send-terminal-input', () => ({ sendTerminalInput: sendInput }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { pty: { resize }, appSettings: { get: async () => ({}) } },
  events: { on: eventOn },
}));
vi.mock('@renderer/lib/hotkeys/dispatch-matching-hotkeys', () => ({ dispatchMatchingHotkeys: () => false }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./pty', () => ({ getFrontendPty: () => undefined, TERMINAL_PADDING_PX: 0 }));

let root: Root;
let dom: JSDOM;
let pty: FrontendPty;
let hostSize: number[];
let dataSubscriptions: number;
let handleInput: (data: string) => void;
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
    dataSubscriptions = 0;
    sendInput.mockReset();
    eventOn.mockImplementation((channel: { name: string }) => {
      if (channel.name !== 'pty:data') return () => {};
      dataSubscriptions += 1;
      return () => { dataSubscriptions -= 1; };
    });
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
      attachInputHandler: (handler: (data: string) => void) => { handleInput = handler; return () => {}; },
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
  it('does not keep a remote output subscription for startup detection while hidden', async () => {
    await show(true);
    await show(false);
    expect(dataSubscriptions).toBe(0);
  });

  it('suppresses focus reports until this terminal has produced live output', async () => {
    await show(true);
    handleInput('\x1b[I');
    expect(sendInput).not.toHaveBeenCalled();
    notifyPtyOutput('another-terminal', 'ready');
    handleInput('\x1b[O');
    expect(sendInput).not.toHaveBeenCalled();
    notifyPtyOutput('remote-task', 'ready');
    handleInput('\x1b[I');
    expect(sendInput).toHaveBeenLastCalledWith('remote-task', '\x1b[I');
  });

});
