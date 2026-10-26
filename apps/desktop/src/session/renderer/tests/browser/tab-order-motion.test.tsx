import { DndContext, type DropAnimationFunction } from '@dnd-kit/core';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { PaneLayoutProvider } from '@renderer/features/tabs/pane-layout-context';
import { PaneContext } from '@renderer/features/tabs/pane-context';
import { TabBar } from '@renderer/features/tabs/tab-bar';
import { DraggableTab } from '@renderer/features/tabs/tab-bar/draggable-tab';
import { GenericTabDragPreview } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { TabChip } from '@renderer/features/tabs/tab-bar/tab-chip';
import { TabDragOverlay } from '@renderer/features/tabs/tab-bar/tab-drag-preview';
import { tabDropAnimation } from '@renderer/features/tabs/tab-bar/tab-motion';
import { useTabDrag } from '@renderer/features/tabs/use-tab-drag';
import { DUR_MED_MS, EASE } from '@/styles/motion';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));

let harness: ReturnType<typeof createReactHarness>;
let layout: PaneLayoutStore;
const records: { node: Element; animation: Animation }[] = [];
let orderAtDrop: string[] = [];
const provider = createTabProvider({
  kind: 'motion-fixture', mount: 'single', resourceKey: (state: { id: string }) => state.id,
  initialize: (entry) => ({ label: entry.state.id, dispose() {} }), dispose() {}, TabContent: () => null,
  TabBarItem: ({ tab, host }) => <div className="contents"><DraggableTab id={tab.tabId} pairRole={tab.pairRole}>
    <TabChip data-tabid={tab.tabId} label={tab.resource.label} isActive={tab.isActive}
      onClick={() => host.setActiveTab(tab.tabId)} />
  </DraggableTab></div>,
  TabBarItemDragPreview: ({ tab }) => <GenericTabDragPreview label={tab.resource.label} />,
});
const pane = () => layout.groups[0].pane;
const id = (name: string) => [...pane().entries.values()].find(entry => (entry.state as { id: string }).id === name)!.tabId;
const node = (name: string) => harness.container.querySelector<HTMLElement>(`[data-tabid="${id(name)}"]`)!.closest<HTMLElement>('.session-tab-slot')!;
const strip = () => harness.container.querySelector<HTMLElement>('.session-tab-bar > .overflow-x-auto')!;
const order = () => [...harness.container.querySelectorAll<HTMLElement>('.session-tab-slot [data-tabid]')].map(e => e.dataset.tabid!);
const lefts = () => new Map(pane().tabOrder.map(tabId => [tabId, harness.container.querySelector<HTMLElement>(`[data-tabid="${tabId}"]`)!.getBoundingClientRect().left]));
const settled = () => until('tab movement finishes', () => [...harness.container.querySelectorAll('.session-tab-slot')].every(e => e.getAnimations().length === 0));

function Strip() {
  const drag = useTabDrag({ layout, blockId: null, contentOf: () => null, openWindow: () => null });
  return <PaneLayoutProvider paneLayout={layout}><DndContext sensors={drag.sensors} onDragStart={drag.onDragStart} onDragMove={drag.onDragMove} onDragEnd={event => { orderAtDrop = order(); drag.onDragEnd(event); }} onDragCancel={drag.onDragCancel}>
    <PaneContext.Provider value={{ paneId: layout.groups[0].paneId, pane: pane(), isFocusedPane: true }}>
      <div style={{ width: 800, display: 'flex', flexDirection: 'column' }}><TabBar /></div>
      <button onClick={() => layout.open('motion-fixture', { id: 'New' }, { beside: true, activate: false })}>open beside</button>
      <button onClick={() => pane().closeTab(id('Middle'))}>close middle</button>
    </PaneContext.Provider><TabDragOverlay />
  </DndContext></PaneLayoutProvider>;
}

async function mount(extraTabs = 0) {
  harness = createReactHarness();
  harness.container.className = 'gugu-skin emlight';
  harness.container.style.cssText = 'position:fixed;left:20px;top:20px';
  layout = new PaneLayoutStore(createTabRegistry([provider]), { viewId: 'motion', place: { kind: 'session', sessionId: 'motion', projectId: 'motion' } }, undefined, { singleStrip: true });
  for (const name of ['Anchor', 'Old', 'Middle', 'Incoming', 'Last', ...Array.from({ length: extraTabs }, (_, i) => `Extra ${i}`), ...(extraTabs ? ['Far'] : [])]) layout.open('motion-fixture', { id: name }, { activate: false });
  layout.setPairAnchor(() => ({ paneId: layout.groups[0].paneId, tabId: id('Anchor') }));
  await act(() => pane().setActiveTab(id('Anchor')));
  const original = Element.prototype.animate;
  vi.spyOn(Element.prototype, 'animate').mockImplementation(function (this: Element, ...args) {
    const animation = original.apply(this, args);
    records.push({ node: this, animation });
    return animation;
  });
  await harness.render(<SessionLocalizationProvider><Strip /></SessionLocalizationProvider>);
}

afterEach(async () => {
  await pointer('mouseReleased', 0, 0);
  harness?.cleanup(); records.length = 0; vi.restoreAllMocks();
  await cdp().send('Emulation.setEmulatedMedia', { features: [] });
});

it('only inserts the new side tab, slides displaced neighbors once, and leaves the anchor and last tab in place', async () => {
  await page.viewport(1280, 800); await mount();
  await act(() => pane().splitBeside(id('Old'), 'right')); await settled(); records.length = 0;
  const beforeOrder = [...pane().tabOrder], before = lefts();
  await userEvent.click(node('Incoming').querySelector<HTMLElement>('[data-tabid]')!);
  expect(pane().tabOrder.filter(tabId => tabId !== id('Incoming'))).toEqual(beforeOrder.filter(tabId => tabId !== id('Incoming')));
  expect(pane().tabOrder.slice(0, 3)).toEqual([id('Anchor'), id('Incoming'), id('Old')]);
  const moving = records.filter(r => r.node.classList.contains('session-tab-slot'));
  expect(moving.map(r => r.node)).toEqual(expect.arrayContaining([node('Incoming'), node('Old'), node('Middle')]));
  expect(new Set(moving.map(r => r.node)).size).toBe(moving.length);
  for (const { animation } of moving) {
    expect(animation.effect!.getTiming().duration).toBe(DUR_MED_MS);
    expect(animation.effect!.getTiming().easing).toBe(`cubic-bezier(${EASE.join(', ')})`);
  }
  await settled();
  for (const name of ['Anchor', 'Last']) {
    expect(node(name).getBoundingClientRect().left).toBeCloseTo(before.get(id(name))!, 3);
    expect(moving.some(r => r.node === node(name))).toBe(false);
  }
});

it('opening and closing also animate tabs whose index stays the same while their equal widths change', async () => {
  await page.viewport(1280, 800); await mount();
  const before = [...pane().tabOrder];
  await userEvent.click(page.getByRole('button', { name: 'open beside', exact: true }));
  expect(pane().tabOrder.filter(tabId => tabId !== id('New'))).toEqual(before);
  await settled(); records.length = 0;
  const index = pane().tabOrder.indexOf(id('Old')), left = node('Old').getBoundingClientRect().left;
  await userEvent.click(page.getByRole('button', { name: 'close middle', exact: true }));
  expect(pane().tabOrder.indexOf(id('Old'))).toBe(index);
  expect(records.some(r => r.node === node('Old'))).toBe(true);
  await settled();
  expect(node('Old').getBoundingClientRect().left).not.toBe(left);
});

async function pointer(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, down = false) {
  const frame = (window.frameElement as HTMLElement | null)?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
  await act(async () => { await cdp().send('Input.dispatchMouseEvent', { type, x: frame.left + x * frame.width / innerWidth, y: frame.top + y * frame.height / innerHeight, button: type === 'mouseMoved' && !down ? 'none' : 'left', buttons: down ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }); });
}

it('makes room during a real pointer drag using the same movement, then commits that preview and lands once', async () => {
  await page.viewport(1280, 800); await mount();
  const before = [...pane().tabOrder], from = node('Old').getBoundingClientRect(), to = node('Incoming').getBoundingClientRect();
  const x = from.left + from.width / 2, y = from.top + from.height / 2;
  await pointer('mouseMoved', x, y); await pointer('mousePressed', x, y, true);
  for (let i = 1; i <= 20; i++) await pointer('mouseMoved', x + (to.right - 5 - x) * i / 20, y, true);
  await until('the drag makes room', () => order().join() !== before.join());
  const preview = order();
  expect(pane().tabOrder).toEqual(before);
  expect(records.some(r => r.node === node('Middle'))).toBe(true);
  await pointer('mouseReleased', to.right - 5, y);
  expect(pane().tabOrder).toEqual(preview);
  await settled();
  await until('the source is visible after the drop', () => getComputedStyle(node('Old')).opacity === '1');
});

it('holds the dropped overlay at its destination until dnd-kit removes it', async () => {
  harness = createReactHarness();
  const source = document.createElement('div'), overlay = document.createElement('div');
  source.style.cssText = 'position:fixed;left:100px;top:40px;width:120px;height:34px;opacity:.6';
  overlay.style.cssText = 'position:fixed;left:260px;top:48px;width:120px;height:34px';
  harness.container.append(source, overlay);
  const destination = source.getBoundingClientRect();
  const completion = (tabDropAnimation as DropAnimationFunction)({
    active: { node: source }, dragOverlay: { node: overlay, rect: overlay.getBoundingClientRect() },
  } as Parameters<DropAnimationFunction>[0]);
  expect(source.style.opacity).toBe('0');
  await completion;
  expect(source.style.opacity).toBe('0.6');
  expect(overlay.isConnected).toBe(true);
  expect(overlay.getBoundingClientRect().left).toBeCloseTo(destination.left, 3);
  expect(overlay.getBoundingClientRect().top).toBeCloseTo(destination.top, 3);
});

it('keeps making room when a pointer drag auto-scrolls the overflowing strip', async () => {
  await page.viewport(1280, 800); await mount(20);
  await until('overflow layout settles', () => !!harness.container.querySelector('[data-tabstrip-overflow] button'));
  const before = [...pane().tabOrder], from = node('Old').getBoundingClientRect();
  const scroller = strip(), bounds = scroller.getBoundingClientRect();
  const x = from.left + from.width / 2, y = from.top + from.height / 2, end = bounds.right - 8;
  await pointer('mouseMoved', x, y); await pointer('mousePressed', x, y, true);
  for (let i = 1; i <= 20; i++) await pointer('mouseMoved', x + (end - x) * i / 20, y, true);
  await until('the overflowing strip auto-scrolls', () => scroller.scrollLeft, left => left > 60);
  await until('the preview still makes room under the pointer', () => order().join() !== before.join());
  expect(pane().tabOrder).toEqual(before);
  await pointer('mouseReleased', end, y);
  expect(pane().tabOrder).toEqual(orderAtDrop);
  expect(orderAtDrop).not.toEqual(before);
  await settled();
});

it('skips movement for reduced motion while retaining the new order', async () => {
  await page.viewport(1280, 800);
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await mount();
  await act(() => pane().splitBeside(id('Old'), 'right')); records.length = 0;
  await act(() => pane().setActiveTab(id('Incoming')));
  expect(pane().tabOrder.slice(0, 2)).toEqual([id('Anchor'), id('Incoming')]);
  expect(records).toHaveLength(0);
});


it('reveals the final position when an offscreen tab moves beside the anchor', async () => {
  await page.viewport(1280, 800); await mount(20);
  await act(() => pane().splitBeside(id('Old'), 'right')); await settled();
  await until('the overflow picker appears', () => !!harness.container.querySelector('[data-tabstrip-overflow] button'));
  await userEvent.click(harness.container.querySelector<HTMLElement>('[data-tabstrip-overflow] button')!);
  await userEvent.click(page.getByRole('menuitem', { name: 'Far', exact: true }));
  await settled();
  expect(pane().tabOrder.slice(0, 2)).toEqual([id('Anchor'), id('Far')]);
  const viewport = strip().getBoundingClientRect(), tab = node('Far').getBoundingClientRect();
  expect(tab.left).toBeGreaterThanOrEqual(viewport.left);
  expect(tab.right).toBeLessThanOrEqual(viewport.right);
});
