import { DndContext } from '@dnd-kit/core';
import { observable } from 'mobx';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';

// owner 10-08 15:35(Beta 61.1):点开任务 A,切到 B,再切回 A ——「只是标题变了,终端没变」。
// 当时保留的任务页靠 visibility:hidden 藏,而 visibility 可以被后代改回:活动页签的内容层写着
// visibility:visible,于是藏着的 B 页把它的终端照画在 A 页上面。现在藏法是 content-visibility:hidden
// (lib/retainedSurface.ts),后代改不回来。判据就是那条不变量本身:藏起来的页里没有任何一个元素看得见
// (checkVisibility 认 display / visibility / content-visibility 整条祖先链)、能拿到焦点、能被 find 找到。

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

/** Everything inside the given page that is still shown. */
function shownIn(page: string): string[] {
  const el = container.querySelector(`[data-page="${page}"]`)!;
  return [...el.querySelectorAll<HTMLElement>('*')]
    .filter((node) => node.checkVisibility({ visibilityProperty: true }))
    .map((node) => node.outerHTML.slice(0, 120));
}
const paintedInHiddenPage = () => shownIn('hidden');

/** Whether focus() lands on the page's button. */
function focusable(page: string): boolean {
  const button = container.querySelector<HTMLButtonElement>(`[data-page="${page}"] button`)!;
  button.focus();
  const landed = document.activeElement === button;
  button.blur();
  return landed;
}

/** Whether find-in-page finds the text. window.find runs the browser's own find over what is rendered. */
function findable(text: string): boolean {
  window.getSelection()?.removeAllRanges();
  return (window as unknown as { find: (text: string) => boolean }).find(text);
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
      const p = pane(name, 'conversation', () => (
        <div data-terminal={name}>
          {name} terminal <button type="button">{name} send</button>
        </div>
      ));
      return (
        <DndContext>
          <PaneContext.Provider value={{ paneId: name, pane: p as never, isFocusedPane: name === 'shown' }}>
            <PaneContent />
          </PaneContext.Provider>
        </DndContext>
      );
    });
    // Positive control: the page on screen does paint its terminal, takes focus and is found.
    expect(container.querySelector<HTMLElement>('[data-terminal="shown"]')!.checkVisibility({ visibilityProperty: true })).toBe(true);
    expect(focusable('shown')).toBe(true);
    expect(findable('shown terminal')).toBe(true);
    expect(paintedInHiddenPage()).toEqual([]);
    expect(focusable('hidden')).toBe(false);
    expect(findable('hidden terminal')).toBe(false);
  });

  it('paints nothing of its active web page tab', async () => {
    const BrowserContent = BrowserTabContent;
    await drawPages((name) => {
      const p = pane(name, 'browser', () => null);
      return <BrowserContent host={p as never} ctx={{} as never} />;
    });
    expect(container.querySelector<HTMLElement>('[data-page="shown"] [data-browser-pane]')!.checkVisibility({ visibilityProperty: true })).toBe(true);
    expect(shownIn('shown').length).toBeGreaterThan(0);
    expect(paintedInHiddenPage()).toEqual([]);
  });
});
