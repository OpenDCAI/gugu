import { act, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ExtensionViewLayer } from '@renderer/features/extensions/extension-view-layer';
import { ExtensionSharedSlot } from '@renderer/features/extensions/extension-shared-slot';
import { extensionViewStore } from '@renderer/features/extensions/extension-view-store';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import { PaneContent } from '@renderer/features/tabs/pane-content';
import { PaneContext } from '@renderer/features/tabs/pane-context';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { tabFullscreen, WORKSPACE_ANCHOR } from '@renderer/features/tabs/tab-fullscreen';
import { ScreenFrame } from '@renderer/app/screen-frame';
import { screenLayout } from '@renderer/app/screen-layout';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import '@/styles/tokens.css';
import '@renderer/index.css';

// Real resident placement and pane DOM; only the Electron bridge is replaced.
// Chromium has no Electron webview process: the native document/PDF cells cover
// guest rendering, while this test checks its host element's clipping and hits.
const manifest = parseExtensionManifest({
  id: 'fullscreen-fixture', name: 'Document', version: '1.0.0',
  apiVersion: EXTENSION_API_VERSION, entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: 'Document' }] },
});
const kind = 'fullscreen-fixture.main';
const registry = createTabRegistry([
  createTabProvider({
    kind: 'document', resourceKey: (state: { id: string }) => state.id,
    initialize: () => ({ dispose() {} }), dispose() {},
    TabBarItem: () => null, TabBarItemDragPreview: () => null,
    TabContent: ({ ctx }) => <ExtensionSharedSlot tabKind={kind} chatId={ctx.viewId} tabId="document" itemId="report.md" />,
  }),
  createTabProvider({
    kind: 'pdf', resourceKey: () => 'pdf', initialize: () => ({ dispose() {} }), dispose() {},
    TabBarItem: () => null, TabBarItemDragPreview: () => null,
    TabContent: () => <canvas aria-label="PDF canvas control" style={{ display: 'block', width: '100%', height: '100%' }} />,
  }),
] as const);

let harness: ReturnType<typeof createReactHarness>;
let serial = 0;

beforeEach(async () => {
  await page.viewport(1280, 900);
  harness = createReactHarness();
  vi.stubGlobal('electronAPI', {
    invoke: async (channel: string) => {
      if (channel === 'extensions.activate') return { success: true, data: { partition: 'fixture', entryUrl: 'about:blank' } };
      if (channel === 'viewState.save') return undefined;
      throw new Error(`Unexpected bridge call: ${channel}`);
    },
    eventOn: () => () => {},
  });
  act(() => { installedExtensionsStore.manifests = [manifest]; });
});

afterEach(() => {
  act(() => tabFullscreen.exit());
  harness.cleanup();
  act(() => {
    for (const block of [...screenLayout.blocks.values(), ...screenLayout.parkedContents]) screenLayout.forgetContent(block);
    extensionViewStore.forgetOpened(kind);
    installedExtensionsStore.manifests = [];
  });
  vi.unstubAllGlobals();
});

async function split() {
  const layouts = ['group', 'direct'].map((name) => {
    const chatId = `${name}-${++serial}`;
    const layout = new PaneLayoutStore(registry, { viewId: chatId }, undefined, { singleStrip: true });
    layout.open('document', { id: 'report.md' }, { preview: false });
    return { layout, chatId };
  });
  await harness.render(<div className="gugu-skin" style={{ position: 'fixed', left: 100, top: 40, width: 1000, height: 600 }}>
    <style>{'webview { display: block; }'}</style>
    <ExtensionViewLayer />
    <div data-screen-frame="" style={{ display: 'flex', height: '100%', anchorName: WORKSPACE_ANCHOR } as CSSProperties}>
      {layouts.map(({ layout, chatId }) => {
        const { paneId, pane } = layout.groups[0]!;
        return <div key={paneId} data-split-block={chatId} style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <PaneContext.Provider value={{ paneId, pane, isFocusedPane: true }}><PaneContent hideTabBar /></PaneContext.Provider>
        </div>;
      })}
    </div>
  </div>);
  await until('both resident documents occupy their split blocks', () =>
    harness.container.querySelectorAll('[data-extension-view] webview').length === 2 &&
    [...harness.container.querySelectorAll<HTMLElement>('[data-extension-view]')].every((box) => box.getBoundingClientRect().width === 500));
  return layouts;
}

function resident(chatId: string) {
  const claim = [...extensionViewStore.claims.values()].find((entry) => entry.chatId === chatId)!;
  expect(claim).toBeDefined();
  const box = [...harness.container.querySelectorAll<HTMLElement>('[data-extension-view]')].find((node) => {
    const rect = node.getBoundingClientRect();
    return Math.abs(rect.left - claim.element.getBoundingClientRect().left) < 1;
  })!;
  expect(box).toBeDefined();
  return { claim, box, guest: box.querySelector('webview')! };
}

for (const side of [0, 1]) {
  it(`fullscreen document in split block ${side} owns every workspace content hit and exits without replacing its guest`, async () => {
    const layouts = await split();
    const { layout, chatId } = layouts[side]!;
    const pane = layout.groups[0]!.pane;
    const { claim, box, guest } = resident(chatId);
    const original = box.getBoundingClientRect().toJSON();
    act(() => tabFullscreen.toggle(pane, pane.resolvedActiveTabId!));
    await until('the resident content expands to the workspace', () => claim.element.getBoundingClientRect().width === 1000);
    // Assert the outer clipping box, not just the guest's full layout width.
    await until('the resident clipping box follows the full workspace', () => box.getBoundingClientRect().width === 1000);
    const content = claim.element.getBoundingClientRect();
    for (const x of [content.left + 5, content.left + content.width / 4, content.left + content.width / 2, content.right - 5]) {
      for (const y of [content.top + 5, content.top + content.height / 2, content.bottom - 5]) {
        expect(document.elementFromPoint(x, y), `workspace content hit at ${x},${y}`).toBe(guest);
      }
    }
    expect(box.querySelector('webview')).toBe(guest);

    // A clip INSIDE the fixed fullscreen boundary still applies.
    const inside = claim.element.parentElement!;
    const priorStyle = inside.getAttribute('style');
    inside.style.overflow = 'hidden';
    inside.style.flex = '0 0 700px';
    inside.style.width = '700px';
    claim.element.style.minWidth = '1000px';
    await until('inner overflow still clips the resident guest', () => box.getBoundingClientRect().width === 700);
    if (priorStyle === null) inside.removeAttribute('style'); else inside.setAttribute('style', priorStyle);
    claim.element.style.removeProperty('min-width');

    act(() => tabFullscreen.exit());
    await until('the original split clipping box is restored', () => JSON.stringify(box.getBoundingClientRect().toJSON()) === JSON.stringify(original));
    expect(box.querySelector('webview')).toBe(guest);
  });
}

it('keeps a host PDF canvas above both split backgrounds when fullscreen', async () => {
  const layouts = await split();
  const { layout } = layouts[1]!;
  act(() => { layout.open('pdf', {}, { preview: false }); });
  const pane = layout.groups[0]!.pane;
  await until('host PDF content is shown', () => harness.container.querySelector('canvas') !== null);
  act(() => tabFullscreen.toggle(pane, pane.resolvedActiveTabId!));
  const canvas = harness.container.querySelector('canvas')!;
  await until('host PDF fills the workspace', () => canvas.getBoundingClientRect().width === 1000);
  const rect = canvas.getBoundingClientRect();
  for (const x of [rect.left + 5, rect.left + rect.width / 2, rect.right - 5]) {
    expect(document.elementFromPoint(x, rect.top + rect.height / 2)).toBe(canvas);
  }
});

// Use the real ScreenFrame/ResizableHandle as well as the real pane and resident
// layer. The screen divider used to choose z-30 independently of the pane table.
async function screenSplit() {
  const layouts = ['group', 'direct'].map((name) => {
    const chatId = `${name}-${++serial}`;
    const layout = new PaneLayoutStore(registry, { viewId: chatId }, undefined, { singleStrip: true });
    layout.open('document', { id: 'report.md' }, { preview: false });
    return { layout, chatId };
  });
  act(() => {
    screenLayout.show({ projectId: 'fullscreen-fixture', sessionId: layouts[0]!.chatId });
    screenLayout.showBeside({ projectId: 'fullscreen-fixture', sessionId: layouts[1]!.chatId });
  });
  let blocks: HTMLElement[] = [];
  const view = () => <div className="gugu-skin" style={{ position: 'fixed', left: 100, top: 40, width: 1000, height: 600 }}>
    <style>{'webview { display: block; }'}</style>
    <ExtensionViewLayer />
    <ScreenFrame />
    {blocks.map((block, side) => {
      const { paneId, pane } = layouts[side]!.layout.groups[0]!;
      return createPortal(<PaneContext.Provider value={{ paneId, pane, isFocusedPane: true }}><PaneContent hideTabBar /></PaneContext.Provider>, block);
    })}
  </div>;
  await harness.render(view());
  await until('the real screen split has two blocks and a divider', () =>
    harness.container.querySelectorAll('[data-screen-block]').length === 2 &&
    harness.container.querySelector('[data-slot="resizable-handle"]') !== null);
  blocks = [...harness.container.querySelectorAll<HTMLElement>('[data-screen-block]')];
  await harness.render(view());
  await until('both resident documents occupy the real screen blocks', () =>
    harness.container.querySelectorAll('[data-extension-view] webview').length === 2 &&
    [...harness.container.querySelectorAll<HTMLElement>('[data-extension-view]')].every((box) => box.getBoundingClientRect().width > 400));
  return layouts;
}

async function resizeScreen(handle: HTMLElement, input: 'pointer' | 'keyboard') {
  if (input === 'keyboard') {
    // Also exercise the library's key listener if focus survives disabling it.
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  } else {
    const rect = handle.getBoundingClientRect();
    let x = rect.left + rect.width / 2;
    let y = rect.top + rect.height / 2;
    let scale = 1;
    // CDP takes top-page coordinates; Vitest renders this test in an iframe.
    for (let frameWindow: Window = window; frameWindow.frameElement; frameWindow = frameWindow.parent) {
      const frame = frameWindow.frameElement as HTMLElement;
      const outer = frame.getBoundingClientRect();
      const factor = outer.width / frame.offsetWidth;
      x = outer.left + (frame.clientLeft + x) * factor;
      y = outer.top + (frame.clientTop + y) * factor;
      scale *= factor;
    }
    const session = cdp() as unknown as { send(method: string, params: object): Promise<unknown> };
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    try {
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 140 * scale, y, button: 'left', buttons: 1 });
    } finally {
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 140 * scale, y, button: 'left', buttons: 0, clickCount: 1 });
    }
  }
  for (let frame = 0; frame < 2; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

for (const contentKind of ['document', 'pdf'] as const) for (const side of [0, 1]) for (const input of ['pointer', 'keyboard'] as const) {
  it(`fullscreen ${contentKind} in real screen block ${side} ignores divider ${input} resizing and restores it on exit`, async () => {
    const layouts = await screenSplit();
    const { layout } = layouts[side]!;
    const pane = layout.groups[0]!.pane;
    const handle = harness.container.querySelector<HTMLElement>('[data-slot="resizable-handle"]')!;
    const initial = handle.getBoundingClientRect().x;
    await resizeScreen(handle, input);
    await until('the normal divider resizes the screen', () => handle.getBoundingClientRect().x < initial - 1);
    if (contentKind === 'pdf') act(() => { layout.open('pdf', {}, { preview: false }); });
    const before = handle.getBoundingClientRect().toJSON();
    const storedLayout = JSON.stringify(screenLayout.layout);
    act(() => tabFullscreen.toggle(pane, pane.resolvedActiveTabId!));
    await until('the pane fills the workspace', () => harness.container.querySelector('[data-tab-fullscreen]')?.getBoundingClientRect().width === 1000);
    await resizeScreen(handle, input);
    expect(handle.getBoundingClientRect().toJSON(), `fullscreen ignores divider ${input} resizing`).toEqual(before);
    expect(JSON.stringify(screenLayout.layout)).toBe(storedLayout);
    act(() => tabFullscreen.exit());
    await until('the same divider is enabled again', () => handle.getAttribute('aria-disabled') !== 'true');
    expect(handle.getBoundingClientRect().toJSON()).toEqual(before);
    await resizeScreen(handle, input);
    await until('the restored divider resizes the screen', () => handle.getBoundingClientRect().x < before.x - 1);
  });
}

for (const contentKind of ['document', 'pdf'] as const) for (const side of [0, 1]) {
  it(`fullscreen ${contentKind} in real screen block ${side} covers every divider hit and restores the divider on exit`, async () => {
    const layouts = await screenSplit();
    const { layout, chatId } = layouts[side]!;
    const pane = layout.groups[0]!.pane;
    const handle = harness.container.querySelector<HTMLElement>('[data-slot="resizable-handle"]')!;
    const original = handle.getBoundingClientRect().toJSON();
    const centreX = original.x + original.width / 2;
    expect(document.elementFromPoint(centreX, original.y + original.height / 2)?.closest('[data-slot="resizable-handle"]')).toBe(handle);
    let surface: Element;
    if (contentKind === 'pdf') {
      act(() => { layout.open('pdf', {}, { preview: false }); });
      await until('the real split contains the PDF canvas', () => harness.container.querySelector('canvas') !== null);
      surface = harness.container.querySelector('canvas')!;
    } else surface = resident(chatId).guest;
    act(() => tabFullscreen.toggle(pane, pane.resolvedActiveTabId!));
    await until('fullscreen content covers the real screen workspace', () => surface.getBoundingClientRect().width === 1000);
    const rect = surface.getBoundingClientRect();
    for (const x of [rect.left + 5, rect.left + rect.width / 4, rect.left + rect.width / 2, rect.left + rect.width * 3 / 4, rect.right - 5, centreX - 3, centreX, centreX + 3]) {
      for (const y of [rect.top + 5, rect.top + rect.height / 2, rect.bottom - 5]) {
        const hit = document.elementFromPoint(x, y);
        expect(hit?.closest('[data-slot="resizable-handle"], [data-pair-divider]'), `fullscreen content cannot hit a divider at ${x},${y}`).toBeNull();
        expect(hit, `fullscreen content owns the hit at ${x},${y}`).toBe(surface);
      }
    }
    act(() => tabFullscreen.exit());
    await until('the same screen divider is hit-testable again', () =>
      document.elementFromPoint(centreX, original.y + original.height / 2)?.closest('[data-slot="resizable-handle"]') === handle);
    expect(handle.getBoundingClientRect().toJSON()).toEqual(original);
  });
}
