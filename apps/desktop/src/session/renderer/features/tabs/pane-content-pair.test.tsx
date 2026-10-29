import { JSDOM } from 'jsdom';
import { observer } from 'mobx-react-lite';
import React, { act, useContext, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabContentProps } from './core/tab-provider';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PairPlacementContext } from './pair-placement-context';
import { PaneContent } from './pane-content';
import { PaneContext } from './pane-context';
import { PaneLayoutStore } from './pane-layout-store';
import { tabFullscreen } from './tab-fullscreen';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 同一种两页并排(spec session-page「并排」):自己摆两页的那种(网页)两页都不挪地方 —— 挪进另起的一份内容
 * 就是重新挂一次,网页会重新加载。每页挂上一次计一次数。
 */
const mounts = new Map<string, number>();

function Page({ tabId }: { tabId: string }) {
  useEffect(() => {
    mounts.set(tabId, (mounts.get(tabId) ?? 0) + 1);
  }, [tabId]);
  return null;
}

function contentOf(kind: string) {
  return observer(function Content({ host }: TabContentProps) {
    const place = useContext(PairPlacementContext);
    return (
      <>
        {host.resolvedTabs
          .filter((tab) => tab.kind === kind)
          .map((tab) => (
            <div key={tab.tabId} data-tab={tab.tabId} data-shown={tab.isActive} style={(tab.isActive && place?.(tab.tabId)) || undefined}>
              <Page tabId={tab.tabId} />
            </div>
          ))}
      </>
    );
  });
}

function provider(kind: string, placesPairItself: boolean) {
  return createTabProvider({
    kind,
    placesPairItself,
    resourceKey: (state: { id: string }) => state.id,
    initialize: () => ({ dispose: () => {} }),
    dispose: () => {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: contentOf(kind),
  });
}

const ctx = { viewId: 's1', projectId: 'p1', workspaceId: 'w1', sessionId: 's1', modelRootPath: 'workspace:w1' };

let root: Root;
let dom: JSDOM;

function mountTwo(kind: 'page' | 'file') {
  const registry = createTabRegistry([provider('chat', false), provider('page', true), provider('file', false)] as const);
  const layout = new PaneLayoutStore(registry, ctx, undefined, { singleStrip: true });
  layout.open('chat', { id: 'conv' });
  layout.open(kind, { id: 'a' }, { preview: false });
  layout.open(kind, { id: 'b' }, { preview: false, activate: false });
  const group = layout.groups[0];
  const pane = group.pane;
  const idOf = (id: string) => [...pane.entries.values()].find((e) => (e.state as { id: string }).id === id)!.tabId;
  act(() =>
    root.render(
      <PaneContext.Provider value={{ paneId: group.paneId, pane, isFocusedPane: true }}>
        <PaneContent hideTabBar />
      </PaneContext.Provider>
    )
  );
  const placed = (id: string) => {
    const el = dom.window.document.querySelectorAll<HTMLElement>(`[data-tab="${idOf(id)}"]`);
    return [...el].map((node) => `${node.dataset.shown}:${node.style.left || '-'}/${node.style.top || '-'}`);
  };
  return { pane, a: idOf('a'), b: idOf('b'), placed };
}

describe('并排:同一种两页时内容不挪地方', () => {
  beforeEach(() => {
    mounts.clear();
    dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    root = createRoot(dom.window.document.getElementById('root')!);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('两个网页并排、拆开、再并排、改成上下:两页一次都不重新挂,各摆一边', () => {
    const { pane, a, b, placed } = mountTwo('page');
    expect([mounts.get(a), mounts.get(b)]).toEqual([1, 1]);

    act(() => void pane.splitTab(b, 'right'));
    expect(placed('a')).toEqual(['true:0px/0px']);
    expect(placed('b')).toEqual(['true:50%/0px']);

    act(() => pane.separatePair());
    act(() => pane.toggleSplit());
    act(() => void pane.splitTab(b, 'bottom'));
    expect(placed('b')).toEqual(['true:0px/50%']);
    expect([mounts.get(a), mounts.get(b)]).toEqual([1, 1]);
  });

  it('对照:不自己摆两页的那种,另一页挪进单独的一份 = 重新挂一次(计数抓得到)', () => {
    const { pane, b } = mountTwo('file');
    act(() => void pane.splitTab(b, 'right'));
    expect(mounts.get(b)).toBe(2);
  });

  it('uses the shared fullscreen layer and restores the divider without remounting', () => {
    const { pane, a, b } = mountTwo('page');
    act(() => pane.splitTab(b, 'right'));
    const divider = () => dom.window.document.querySelector<HTMLElement>('[data-pair-divider]');
    expect(divider()?.style.zIndex).toBe('var(--z-pane-divider)');
    try {
      act(() => pane.tabFill(b)!.toggle());
      const fullscreen = dom.window.document.querySelector<HTMLElement>('[data-tab-fullscreen]')!;
      expect(fullscreen.style.position).toBe('fixed');
      expect(fullscreen.style.zIndex).toBe('var(--z-pane-fullscreen)');
      expect(divider()).toBeNull();
      expect([mounts.get(a), mounts.get(b)]).toEqual([1, 1]);
    } finally {
      act(() => tabFullscreen.exit());
    }
    expect(dom.window.document.querySelector('[data-tab-fullscreen]')).toBeNull();
    expect(divider()?.style.zIndex).toBe('var(--z-pane-divider)');
    expect([mounts.get(a), mounts.get(b)]).toEqual([1, 1]);
  });

  it.each(['a', 'b'] as const)('shows only fullscreen page %s and restores its pair without remounting', (selected) => {
    const { pane, a, b, placed } = mountTwo('page');
    act(() => {
      pane.splitTab(b, 'right');
      pane.setPairRatio(0.4);
      pane.setActiveTab(selected === 'a' ? a : b);
    });
    const before = pane.snapshot;
    const positions = [placed('a'), placed('b')];
    expect(pane.shownTabIds).toEqual([a, b]);
    expect(positions).toEqual([['true:0px/0px'], ['true:40%/0px']]);

    try {
      act(() => tabFullscreen.toggle(pane, selected === 'a' ? a : b));
      expect(pane.shownTabIds).toEqual([selected === 'a' ? a : b]);
      expect(placed(selected)).toEqual(['true:-/-']);
      expect(placed(selected === 'a' ? 'b' : 'a')).toEqual(['false:-/-']);
      expect(pane.snapshot).toEqual(before);
      expect([mounts.get(a), mounts.get(b)]).toEqual([1, 1]);
    } finally {
      act(() => tabFullscreen.exit());
    }

    expect([placed('a'), placed('b')]).toEqual(positions);
    expect(pane.snapshot).toEqual(before);
    expect([mounts.get(a), mounts.get(b)]).toEqual([1, 1]);
  });
});
