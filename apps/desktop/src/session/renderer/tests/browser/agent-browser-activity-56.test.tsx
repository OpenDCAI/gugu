import { act } from 'react';
import { observer } from 'mobx-react-lite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';

const mocks = vi.hoisted(() => ({
  agentState: vi.fn(),
  pauseAgent: vi.fn(),
  forwardAgentCursorInput: vi.fn().mockResolvedValue({ success: true }),
  setAgentCursorShown: vi.fn(),
  agentCursorArrived: vi.fn(),
  closeAgentOverlayLayers: vi.fn().mockResolvedValue({ success: true }),
  handlers: new Set<(payload: { browserId: string; state: string }) => void>(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: (_channel: unknown, handler: (payload: { browserId: string; state: string }) => void) => {
    mocks.handlers.add(handler);
    return () => mocks.handlers.delete(handler);
  } },
  rpc: { browser: { agentState: mocks.agentState, pauseAgent: mocks.pauseAgent,
    forwardAgentCursorInput: mocks.forwardAgentCursorInput, setAgentCursorShown: mocks.setAgentCursorShown,
    agentCursorArrived: mocks.agentCursorArrived, closeAgentOverlayLayers: mocks.closeAgentOverlayLayers } },
}));
vi.mock('@renderer/utils/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const { agentBrowserState, useAgentBrowserStateSync, syncAgentBrowserState } = await import('@renderer/features/browser/agent-browser-state');
const { AgentBrowserCursor } = await import('@renderer/features/browser/agent-browser-cursor');
const Probe = observer(function Probe({ browserId, active }: { browserId: string; active: boolean }) {
  useAgentBrowserStateSync(browserId, active, window);
  return <output>{agentBrowserState(browserId)}</output>;
});
const emit = (browserId: string, state: string) => act(async () => mocks.handlers.forEach(handler => handler({ browserId, state })));
let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { vi.clearAllMocks(); harness = createReactHarness(); });
afterEach(() => harness.cleanup());

it('queries current activity when the driving event happened before the renderer mounted', async () => {
  mocks.agentState.mockResolvedValue({ state: 'driving' });
  await harness.render(<Probe browserId="late-activity" active />);
  await vi.waitFor(() => expect(harness.container.textContent).toBe('driving'));
});

it('does not overwrite a newer idle event with a stale activity query', async () => {
  let answer!: (value: { state: string }) => void;
  mocks.agentState.mockReturnValue(new Promise(resolve => answer = resolve));
  await harness.render(<Probe browserId="activity-race" active />);
  await emit('activity-race', 'idle');
  await act(async () => answer({ state: 'driving' }));
  expect(harness.container.textContent).toBe('idle');
});

it('ignores older activity queries when replies arrive out of order', async () => {
  const answers: Array<(value: { state: string }) => void> = [];
  mocks.agentState.mockImplementation(() => new Promise(resolve => answers.push(resolve)));
  await harness.render(<Probe browserId="activity-query-order" active />);
  const newer = syncAgentBrowserState('activity-query-order');
  await act(async () => { answers[1]({ state: 'idle' }); await newer; });
  await act(async () => answers[0]({ state: 'driving' }));
  expect(harness.container.textContent).toBe('idle');
});

it('refreshes activity when a hidden pane becomes visible and when its window regains focus', async () => {
  mocks.agentState.mockResolvedValue({ state: 'driving' });
  await harness.render(<Probe browserId="activity-visible" active={false} />);
  expect(mocks.agentState).not.toHaveBeenCalled();
  await harness.render(<Probe browserId="activity-visible" active />);
  await vi.waitFor(() => expect(harness.container.textContent).toBe('driving'));
  mocks.agentState.mockResolvedValue({ state: 'idle' });
  await act(async () => void window.dispatchEvent(new Event('focus')));
  await vi.waitFor(() => expect(harness.container.textContent).toBe('idle'));
});

it('forwards real pointer input on the cursor canvas, including wheel and drag modifiers, without pausing', async () => {
  await emit('cursor-input', 'driving');
  await harness.render(<AgentBrowserCursor browserId="cursor-input" visible />);
  const canvas = harness.container.querySelector('canvas')!;
  await act(async () => {
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 12, clientY: 24, button: 0, buttons: 1, shiftKey: true, detail: 2 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 50, buttons: 1 }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 40, clientY: 50, button: 0 }));
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, clientX: 40, clientY: 50, deltaX: 3, deltaY: 80, deltaMode: 0 }));
  });
  expect(mocks.pauseAgent).not.toHaveBeenCalled();
  // A real browser may also enter/leave the newly mounted canvas under its physical
  // cursor. Assert the explicit input sequence without rejecting those valid events.
  expect(mocks.forwardAgentCursorInput.mock.calls.map(([args]) => args)
    .filter(({ input }) => ['mouseDown', 'mouseMove', 'mouseUp', 'mouseWheel'].includes(input.type))).toEqual([
    { browserId: 'cursor-input', input: { type: 'mouseDown', x: 12, y: 24, button: 'left', clickCount: 2, modifiers: ['shift', 'leftbuttondown'] } },
    { browserId: 'cursor-input', input: { type: 'mouseMove', x: 40, y: 50, button: 'left', clickCount: 0, modifiers: ['leftbuttondown'] } },
    { browserId: 'cursor-input', input: { type: 'mouseUp', x: 40, y: 50, button: 'left', clickCount: 0, modifiers: [] } },
    { browserId: 'cursor-input', input: { type: 'mouseWheel', x: 40, y: 50, deltaX: -3, deltaY: -80, hasPreciseScrollingDeltas: true, canScroll: true, modifiers: [] } },
  ]);
});


it('keeps the floating shortcut layer mounted while browser activity starts and ends', async () => {
  const { AgentBrowserOverlay } = await import('@renderer/features/browser/agent-browser-overlay');
  const frames: HTMLIFrameElement[] = [];
  const opened = vi.spyOn(window, 'open').mockImplementation(() => {
    const frame = document.createElement('iframe');
    document.body.append(frame); frames.push(frame); return frame.contentWindow;
  });
  try {
    const host = document.createElement('div');
    await harness.render(<AgentBrowserOverlay browserId="floating-stability" hostElement={host} visible assistant={<button>shortcut</button>} />);
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    const badge = frames[0].contentDocument!;
    const control = badge.querySelector('button');
    expect(control).not.toBeNull();
    await emit('floating-stability', 'driving');
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(2));
    await emit('floating-stability', 'idle');
    expect(badge.querySelector('button')).toBe(control);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(mocks.closeAgentOverlayLayers).toHaveBeenCalledTimes(1);
    expect(mocks.closeAgentOverlayLayers.mock.calls[0][0][0]).toContain(':cursor:');
  } finally {
    await harness.cleanup(); opened.mockRestore(); frames.forEach(frame => frame.remove());
  }
});
