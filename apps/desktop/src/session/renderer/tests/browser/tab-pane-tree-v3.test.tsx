import { act, useEffect } from 'react';
import { afterAll, afterEach, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { PaneTreeView } from '@renderer/features/tabs/pane-tree-view';
import '@renderer/index.css';
import '@/styles/tokens.css';

let harness: ReturnType<typeof createReactHarness>;
let layout: PaneLayoutStore;
const viewport = { width: window.innerWidth, height: window.innerHeight };
afterAll(() => page.viewport(viewport.width, viewport.height));
afterEach(() => { harness?.cleanup(); layout?.dispose(); });

async function mount() {
  await page.viewport(1100, 800);
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px';
  const provider = createTabProvider({ kind: 'page', resourceKey: (state: { id: string }) => state.id, initialize: () => ({ dispose() {} }), dispose() {}, TabContent: () => null, TabBarItem: () => null, TabBarItemDragPreview: () => null });
  layout = new PaneLayoutStore(createTabRegistry([provider]), { viewId: 'tree-v3' });
  layout.open('page', { id: 'conversation' }, { from: null, intent: 'newTab' });
  const other = layout.open('page', { id: 'folder' }, { from: null, intent: 'newTab' })!;
  layout.focusedPane.setDimensions(harness.container.clientWidth, harness.container.clientHeight);
  expect(layout.splitPane(layout.activePaneId, 'right', other)).toBe(true);
  await act(() => harness.render(<PaneTreeView layout={layout} renderPane={(id, _first, _last, part) => (part === 'bar' ? null : <iframe title={id} style={{ width: '100%', height: '100%' }} />)} />));
  await until('the actual split has a measurable divider', () => harness.container.querySelector<HTMLElement>('[data-slot="resizable-handle"]')?.getBoundingClientRect().height ?? 0, (height) => height > 100);
}

it('shields embedded pages during a real divider drag and releases the shield on mouse-up', async () => {
  await mount();
  const separator = harness.container.querySelector<HTMLElement>('[data-slot="resizable-handle"]')!;
  const rect = separator.getBoundingClientRect();
  const before = JSON.stringify(layout.snapshot.layout);
  const x = rect.left + rect.width / 2;
  const y = rect.top + 80;
  expect(separator.contains(document.elementFromPoint(x, y)), JSON.stringify({ divider: rect.toJSON(), viewport: { width: innerWidth, height: innerHeight }, hit: document.elementFromPoint(x, y)?.outerHTML.slice(0, 250) })).toBe(true);
  const mouse = async (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', localX: number, pressed = false) => {
    let x = localX, topY = y;
    for (let current: Window = window; current.frameElement; current = current.parent) {
      const frame = current.frameElement as HTMLElement, box = frame.getBoundingClientRect();
      const scale = box.width / frame.offsetWidth;
      x = box.left + (frame.clientLeft + x) * scale;
      topY = box.top + (frame.clientTop + topY) * scale;
    }
    await cdp().send('Input.dispatchMouseEvent', { type, x, y: topY, button: type === 'mouseMoved' && !pressed ? 'none' : 'left', buttons: pressed ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  };
  await mouse('mouseMoved', x);
  await mouse('mousePressed', x, true);
  try {
    await until('the divider enables the shared native-page shield', () => document.documentElement.hasAttribute('data-gugu-dragging'));
    expect(getComputedStyle(harness.container.querySelector('iframe')!).pointerEvents).toBe('none');
    await mouse('mouseMoved', x + 80, true);
  } finally {
    await mouse('mouseReleased', x + 80);
  }
  await until('the user resize is saved', () => JSON.stringify(layout.snapshot.layout), (value) => value !== before);
  expect(document.documentElement.hasAttribute('data-gugu-dragging')).toBe(false);
});

it('narrowing and widening only change visibility, preserving both panes, tabs and layout shares', async () => {
  await mount();
  const before = JSON.stringify(layout.snapshot);
  harness.container.style.width = '300px';
  await until('the real tree narrows', () => !!harness.container.querySelector('[data-pane-tree-narrow]'));
  expect(harness.container.querySelectorAll('iframe')).toHaveLength(2);
  expect(JSON.stringify(layout.snapshot)).toBe(before);
  harness.container.style.width = '1000px';
  await until('the same tree widens again', () => !harness.container.querySelector('[data-pane-tree-narrow]'));
  expect(JSON.stringify(layout.snapshot)).toBe(before);
});

it('splitting and closing a pane keep the pane that stays mounted, its page the same node', async () => {
  await page.viewport(1100, 800);
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px';
  const provider = createTabProvider({ kind: 'page', resourceKey: (state: { id: string }) => state.id, initialize: () => ({ dispose() {} }), dispose() {}, TabContent: () => null, TabBarItem: () => null, TabBarItemDragPreview: () => null });
  layout = new PaneLayoutStore(createTabRegistry([provider]), { viewId: 'tree-v3-keep' });
  layout.open('page', { id: 'conversation' }, { from: null, intent: 'newTab' });
  const file = layout.open('page', { id: 'file' }, { from: null, intent: 'newTab' })!;
  layout.focusedPane.setDimensions(harness.container.clientWidth, harness.container.clientHeight);
  const kept = layout.activePaneId;
  const mounts: string[] = [];
  function Page({ id }: { id: string }) {
    useEffect(() => { mounts.push(`mount ${id === kept ? 'kept' : 'other'}`); return () => { mounts.push(`unmount ${id === kept ? 'kept' : 'other'}`); }; }, [id]);
    return <iframe title={id} style={{ width: '100%', height: '100%' }} />;
  }
  await act(() => harness.render(<PaneTreeView layout={layout} renderPane={(id, _first, _last, part) => (part === 'bar' ? null : <Page id={id} />)} />));
  const page0 = harness.container.querySelector(`iframe[title="${kept}"]`);
  await act(() => { expect(layout.splitPane(kept, 'right', file)).toBe(true); });
  const other = layout.groups.find(({ paneId }) => paneId !== kept)!.paneId;
  await until('the kept pane fills the left half', () => harness.container.querySelector(`iframe[title="${kept}"]`)?.getBoundingClientRect().width ?? 0, (width) => Math.abs(width - 499.5) < 2);
  expect(harness.container.querySelector(`iframe[title="${kept}"]`)).toBe(page0);
  await act(() => layout.closePane(other));
  await until('the kept pane fills the tree again', () => harness.container.querySelector(`iframe[title="${kept}"]`)?.getBoundingClientRect().width ?? 0, (width) => width === 1000);
  expect(harness.container.querySelector(`iframe[title="${kept}"]`)).toBe(page0);
  expect(mounts).toEqual(['mount kept', 'mount other', 'unmount other']);
});
