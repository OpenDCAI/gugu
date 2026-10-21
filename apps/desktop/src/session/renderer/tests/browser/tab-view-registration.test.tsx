import { DndContext } from '@dnd-kit/core';
import { observable } from 'mobx';
import { act, Component, lazy, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 页签内容走的真路径(@@@tab-views):provider 的 TabContent 是 registeredTabView(kind),内容组件由任务页入口
// React.lazy 后登记;PaneContent 给内容层包了 Suspense。这里经 PaneContent 开一个页签，看这三段接得上。

vi.mock('@renderer/features/tabs/tab-bar', () => ({ TabBar: () => null }));
vi.mock('@renderer/features/tabs/unavailable-tab', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/features/tabs/unavailable-tab')>()),
  isUnavailableTabResource: () => false,
  UnavailableTabContent: () => null,
}));

const { PaneContent } = await import('@renderer/features/tabs/pane-content');
const { PaneContext } = await import('@renderer/features/tabs/pane-context');
const { registerTabViews, registeredTabView } = await import('@renderer/features/tabs/core/tab-views');

let container: HTMLDivElement;
let root: Root;
let caught: Error | null;

class Catch extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    caught = error;
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

beforeEach(() => {
  caught = null;
  container = document.createElement('div');
  container.style.cssText = 'position:relative;width:800px;height:600px';
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 一个开着 kind 那种页签的 pane,它的 provider 就是 registeredTabView(kind) —— 与任务页的 10 种页签同一条。 */
async function openTab(kind: string) {
  const tab = { tabId: `${kind}-tab`, kind, isActive: true, isPreview: false, resource: {} };
  const pane = observable(
    {
      resolvedTabs: [tab],
      ctx: {},
      registry: { all: () => [{ kind, TabContent: registeredTabView(kind) }], has: () => true },
      dimensions: null,
      setDimensions() {},
      setContentFocuser() {},
    },
    { resolvedTabs: observable.ref, registry: false, ctx: false }
  );
  await act(async () => {
    root.render(
      <Catch>
        <DndContext>
          <PaneContext.Provider value={{ paneId: kind, pane: pane as never, isFocusedPane: true }}>
            <PaneContent />
          </PaneContext.Provider>
        </DndContext>
      </Catch>
    );
  });
  return () => container.querySelector(`[data-pane-layer="${kind}"]`);
}

describe('tab content through the registry and Suspense', () => {
  it('a lazily registered view: the layer stays empty while it loads, then shows the view', async () => {
    let resolveView!: (module: { default: ComponentType }) => void;
    const loading = new Promise<{ default: ComponentType }>((resolve) => {
      resolveView = resolve;
    });
    registerTabViews({ 'lazy-probe': lazy(() => loading) });

    const layer = await openTab('lazy-probe');
    expect(layer()).not.toBeNull();
    expect(layer()!.querySelector('[data-probe]')).toBeNull();
    expect(caught).toBeNull();

    await act(async () => {
      resolveView({ default: () => <div data-probe="">probe view</div> });
      await loading;
    });
    expect(layer()!.querySelector('[data-probe]')?.textContent).toBe('probe view');
    expect(caught).toBeNull();
  });

  it('a kind nobody registered fails loudly instead of showing an empty tab', async () => {
    await openTab('never-registered');
    expect(caught?.message).toMatch(/tab view for kind "never-registered" is not registered/);
  });
});
