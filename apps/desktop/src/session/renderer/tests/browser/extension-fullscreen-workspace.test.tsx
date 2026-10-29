import { act, type CSSProperties } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
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
