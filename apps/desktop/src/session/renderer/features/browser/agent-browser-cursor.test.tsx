// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility';
import { browserAgentCursorChannel, browserAgentStateChannel } from '@shared/events/browserEvents';
import { MotionPlayer } from '@renderer/lib/vendor/cua-cursor-motion';
import { AgentBrowserCursor } from './agent-browser-cursor';

const wire = vi.hoisted(() => ({
  listeners: new Map<string, (value: never) => void>(),
  arrived: vi.fn(async () => {}),
  shown: vi.fn(async () => {}),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: (channel: { name: string }, listener: (value: never) => void) => {
    wire.listeners.set(channel.name, listener);
    return () => wire.listeners.delete(channel.name);
  } },
  rpc: { browser: { agentCursorArrived: wire.arrived, setAgentCursorShown: wire.shown } },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const frames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  vi.clearAllMocks();
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  frames.clear();
  let frameId = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++frameId, callback); return frameId; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(private changed: ResizeObserverCallback) {}
    observe(target: Element) {
      Object.defineProperty(target, 'clientWidth', { configurable: true, value: 640 });
      Object.defineProperty(target, 'clientHeight', { configurable: true, value: 480 });
      this.changed([], this as unknown as ResizeObserver);
    }
    disconnect() {}
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('stops the decorative frame loop on hide, completes an in-flight arrival, and resumes without blocking hidden moves', async () => {
  const browserId = 'animation-cursor';
  wire.listeners.get(browserAgentStateChannel.name)!({ browserId, state: 'driving' } as never);
  const place = vi.spyOn(MotionPlayer.prototype, 'place');
  await act(async () => root.render(<AgentBrowserCursor browserId={browserId} visible />));
  expect(frames.size).toBe(1);
  const move = (moveId: number, x: number, y: number) => wire.listeners.get(browserAgentCursorChannel.name)!({ browserId, kind: 'move', moveId, x, y } as never);
  act(() => move(1, 120, 180));
  expect(wire.arrived).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false })));
  expect(frames.size).toBe(0);
  expect(place).toHaveBeenLastCalledWith({ x: 120, y: 180 });
  expect(wire.arrived).toHaveBeenCalledWith(1);
  await act(async () => move(2, 240, 300));
  expect(wire.arrived).toHaveBeenCalledWith(2);
  expect(frames.size).toBe(0);
  await act(async () => window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true })));
  expect(frames.size).toBe(1);
  expect(place).toHaveBeenLastCalledWith({ x: 240, y: 300 });
});
