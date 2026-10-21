import { DndContext } from '@dnd-kit/core';
import { observable } from 'mobx';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';

// owner 10-08 15:35(Beta 61.1):点开任务 A,切到 B,再切回 A ——「只是标题变了,终端没变」。
// 保留的任务页靠 visibility:hidden 藏(@@@retained-session-pages),而 visibility 可以被后代改回:
// 活动页签的内容层写着 visibility:visible,于是藏着的 B 页把它的终端照画在 A 页上面。
// 判据就是那条不变量本身:藏起来的页里,没有任何一个元素算出来是 visible。

vi.mock('@renderer/features/tabs/tab-bar', () => ({ TabBar: () => null }));
// 其余导出照真的(pane-store 经 pane-content 引进来,要 createUnavailableTabResource)。
vi.mock('@renderer/features/tabs/unavailable-tab', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/features/tabs/unavailable-tab')>()),
  isUnavailableTabResource: () => false,
  UnavailableTabContent: () => null,
}));
vi.mock('@renderer/features/browser/browser-pane', () => ({
  BrowserPane: () => <div data-browser-pane="">page</div>,
}));

const { PaneContent } = await import('@renderer/features/tabs/pane-content');
const { PaneContext } = await import('@renderer/features/tabs/pane-context');
const { PageShownContext } = await import('@renderer/app/recent-session-pages');
const { TabContent: BrowserTabContent } = await import('@renderer/features/browser/browser-tab-view');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  container.style.cssText = 'position:relative;width:800px;height:600px';
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Two retained pages the way workspace.tsx draws them: the one first opened is on screen, the later one is hidden. */
async function drawPages(page: (name: string) => ReactNode) {
  await act(async () => {
    root.render(
      <>
        {['shown', 'hidden'].map((name) => (
          <div
            key={name}
            data-page={name}
            inert={name === 'hidden'}
            className="flex h-full flex-col"
            style={name === 'hidden' ? RETAINED_SURFACE_HIDDEN_STYLE : undefined}
          >
            <PageShownContext.Provider value={name === 'shown'}>{page(name)}</PageShownContext.Provider>
          </div>
        ))}
      </>
    );
  });
}

/** Everything inside the hidden page that would still be painted. */
function paintedInHiddenPage(): string[] {
  const hidden = container.querySelector('[data-page="hidden"]')!;
  return [...hidden.querySelectorAll<HTMLElement>('*')]
    .filter((el) => getComputedStyle(el).visibility === 'visible')
    .map((el) => el.outerHTML.slice(0, 120));
}

function pane(name: string, kind: string, TabContent: (props: { host: never; ctx: never }) => ReactNode) {
  const tab = { tabId: `${name}-tab`, kind, isActive: true, isPreview: false, resource: { browserId: `${name}-browser` } };
  return observable(
    {
      resolvedTabs: [tab],
      ctx: {},
      registry: { all: () => [{ kind, TabContent }], has: () => true },
      dimensions: null,
      setDimensions() {},
      setContentFocuser() {},
    },
    { resolvedTabs: observable.ref, registry: false, ctx: false }
  );
}

describe('a retained session page that is not on screen', () => {
  it('paints nothing of its active tab (the session terminal, 61.1)', async () => {
    await drawPages((name) => {
      const p = pane(name, 'conversation', () => <div data-terminal={name}>{name} terminal</div>);
      return (
        <DndContext>
          <PaneContext.Provider value={{ paneId: name, pane: p as never, isFocusedPane: name === 'shown' }}>
            <PaneContent />
          </PaneContext.Provider>
        </DndContext>
      );
    });
    // Positive control: the page on screen does paint its terminal.
    expect(getComputedStyle(container.querySelector('[data-terminal="shown"]')!).visibility).toBe('visible');
    expect(paintedInHiddenPage()).toEqual([]);
  });

  it('paints nothing of its active web page tab', async () => {
    const BrowserContent = BrowserTabContent;
    await drawPages((name) => {
      const p = pane(name, 'browser', () => null);
      return <BrowserContent host={p as never} ctx={{} as never} />;
    });
    expect(getComputedStyle(container.querySelector('[data-page="shown"] [data-browser-pane]')!).visibility).toBe(
      'visible'
    );
    expect(paintedInHiddenPage()).toEqual([]);
  });
});
