// @vitest-environment jsdom
import { act, useRef, type ReactNode, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { screenLayout } from '@renderer/app/screen-layout';
import { groupParticipantPanes } from '@renderer/features/chats/group-participant-panes';

const state = vi.hoisted(() => ({ extent: 966, layout: {} as Record<string, number>, observers: new Set<() => void>() }));
vi.mock('react-resizable-panels', () => ({
  useGroupRef: () => useRef({
    getLayout: () => state.layout,
    setLayout: (layout: Record<string, number>) => { state.layout = layout; },
  }),
}));
vi.mock('@renderer/lib/ui/resizable', () => ({
  ResizablePanelGroup: ({ children, elementRef }: { children: ReactNode; elementRef?: Ref<HTMLDivElement> }) => <div ref={elementRef}>{children}</div>,
  ResizablePanel: ({ children, id }: { children: ReactNode; id: string }) => <div data-panel-id={id}>{children}</div>,
  ResizableHandle: () => <div />,
}));
vi.mock('@renderer/app/project-block', () => ({ ProjectBlock: () => null }));
const { ScreenFrame } = await import('@renderer/app/screen-frame');
let root: Root;
let host: HTMLDivElement;
let sourceId: string;
let targetId: string;
const source = { kind: 'project', projectId: 'resize-project' } as const;
const target = { kind: 'session', projectId: 'resize-project', sessionId: 'resize-agent' } as const;
const actualRightWidth = () => state.extent * state.layout[`block-panel-${targetId}`]! / 100;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; }
    observe() { state.observers.add(this.callback); }
    disconnect() { state.observers.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const panel = this.closest<HTMLElement>('[data-panel-id]');
    const width = panel ? state.extent * (state.layout[panel.dataset.panelId!] ?? 0) / 100 : state.extent + 1;
    return { width, height: 600, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 600, toJSON: () => ({}) };
  });
  groupParticipantPanes.useAccount('width-resize-test');
  groupParticipantPanes.rememberWidth(550.625);
  screenLayout.show(source);
  groupParticipantPanes.show('resize-group', source, target, 966);
  sourceId = screenLayout.blockOf(source)!;
  targetId = screenLayout.blockOf(target)!;
  state.extent = 966;
  state.layout = { [`block-panel-${sourceId}`]: 43, [`block-panel-${targetId}`]: 57 };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<ScreenFrame />));
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  for (const block of [...screenLayout.blocks.values(), ...screenLayout.parkedContents]) screenLayout.forgetContent(block);
  groupParticipantPanes.useAccount(null);
  state.observers.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each([{ extent: 446, left: 49.327 }, { extent: 486, left: 45.267 }])('restores the saved width after narrowing to $extent and widening, without reopening A', ({ extent, left }) => {
  const saved = localStorage.getItem('gugu.group-participant-pane.v1:width-resize-test');
  // B2 used 760px; 800px is also reachable at the normal native window minimum.
  act(() => {
    state.extent = 586;
    for (const notify of state.observers) notify();
  });
  expect.soft(actualRightWidth()).toBeCloseTo(366, 2);
  act(() => {
    state.extent = extent;
    state.layout = { [`block-panel-${sourceId}`]: left, [`block-panel-${targetId}`]: 100 - left };
    for (const notify of state.observers) notify();
  });
  expect(actualRightWidth()).toBeCloseTo(extent - 220, 2);
  act(() => {
    state.extent = 966;
    for (const notify of state.observers) notify();
  });
  expect(actualRightWidth()).toBeCloseTo(550.625, 2);
  expect(groupParticipantPanes.rightWidth).toBe(550.625);
  expect(localStorage.getItem('gugu.group-participant-pane.v1:width-resize-test')).toBe(saved);
  expect(screenLayout.blockOf(target)).toBe(targetId);
});

it('disconnects its size observer when the participant view closes', () => {
  expect(state.observers.size).toBe(1);
  act(() => groupParticipantPanes.hide('resize-group'));
  expect(state.observers.size).toBe(0);
});

it('keeps ordinary independently opened blocks on their existing ratio behavior', () => {
  act(() => groupParticipantPanes.useAccount(null));
  expect(state.observers.size).toBe(0);
  const original = { ...state.layout };
  act(() => {
    state.extent = 700;
    for (const notify of state.observers) notify();
  });
  expect(state.layout).toEqual(original);
});

it('ignores transient zero-size frames and uses an updated explicit width', () => {
  act(() => groupParticipantPanes.rememberWidth(600));
  expect(actualRightWidth()).toBeCloseTo(600, 2);
  const original = { ...state.layout };
  act(() => {
    state.extent = 0;
    for (const notify of state.observers) notify();
  });
  expect(state.layout).toEqual(original);
  act(() => {
    state.extent = 966;
    for (const notify of state.observers) notify();
  });
  expect(actualRightWidth()).toBeCloseTo(600, 2);
  expect(groupParticipantPanes.rightWidth).toBe(600);
});
