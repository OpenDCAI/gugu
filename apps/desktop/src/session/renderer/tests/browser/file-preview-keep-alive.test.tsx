import { createRoot, type Root } from 'react-dom/client';
import { act, useEffect, type ReactNode } from 'react';
import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';

// owner 2026-10-05:「一个 html 浏览到一半,我切换下标签页再切回来就要重新加载,太影响体验了」。
// 文件页签的预览从前只给活动的那一个挂:切走就卸载(撤掉预览登记),切回来重新登记、重新加载、滚动归零。
// 这里判的是挂载本身 —— 预览换成一个只记「挂上 / 卸下」的替身,其余家具一律替身,只留 FileContent 的挂法。

const mocks = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('@renderer/features/sessions/editor/file-content-preview', () => ({
  FileContentPreview: ({ tab }: { tab: { path: string } }) => {
    useEffect(() => {
      mocks.events.push(`mount ${tab.path}`);
      return () => {
        mocks.events.push(`unmount ${tab.path}`);
      };
    }, [tab]);
    return (
      <div data-preview={tab.path}>
        {tab.path} preview <button type="button">{tab.path} open</button>
      </div>
    );
  },
}));
vi.mock('@renderer/features/sessions/editor/file-content-types', () => ({
  FILE_CONTENT_TYPES: { html: { editable: true, Preview: () => null }, text: { editable: true } },
}));
vi.mock('@renderer/features/sessions/editor/editor-provider', () => ({
  EditorProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@renderer/features/sessions/editor/file-content-renderer', () => ({ FileContentRenderer: () => null }));
vi.mock('@renderer/features/sessions/editor/file-content-toolbar', () => ({
  FileContentToolbar: ({ tab }: { tab: { path: string } }) => <div data-toolbar={tab.path} />,
}));
vi.mock('@renderer/features/sessions/editor/editor-file-tree', () => ({ EditorFileTree: () => null }));
vi.mock('@renderer/features/sessions/editor/file-tab-item', () => ({
  FileTabBarItem: () => null,
  FileTabBarItemDragPreview: () => null,
}));
vi.mock('@renderer/features/sessions/editor/stores/file-model-manager', () => ({ getFileModelManager: vi.fn() }));
vi.mock('@renderer/features/sessions/editor/stores/file-tab-resource', () => ({ FileTabResource: class {} }));
vi.mock('@renderer/features/sessions/workspace-backend/workspace-backend', () => ({ workspaceBackend: vi.fn() }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: vi.fn() }));
vi.mock('@renderer/lib/monaco/monaco-model-registry', () => ({
  modelRegistry: { deletedOnDisk: new Set(), isDirty: () => false },
}));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string) => key }),
}));
vi.mock('@renderer/lib/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  ResizableHandle: () => null,
}));

const { TabContent: FileTabContent } = await import('@renderer/features/sessions/editor/file-tab-view');
const { KEPT_HIDDEN_TABS: KEPT_HIDDEN_PREVIEWS } = await import('@renderer/features/tabs/retained-tab-content');

type Tab = {
  tabId: string;
  kind: string;
  isPreview: boolean;
  isActive: boolean;
  resource: { path: string; isExternal: boolean; bufferUri: string; contentType: string; viewMode: string };
};

function fileTab(path: string): Tab {
  const resource = observable({ path, isExternal: false, bufferUri: '', contentType: 'html', viewMode: 'preview' });
  return { tabId: `tab-${path}`, kind: 'file', isPreview: false, isActive: false, resource };
}

const browserTab: Tab = {
  tabId: 'tab-browser',
  kind: 'browser',
  isPreview: false,
  isActive: false,
  resource: { path: '', isExternal: false, bufferUri: '', contentType: 'html', viewMode: 'preview' },
};

let container: HTMLDivElement;
let root: Root;
let host: { resolvedTabs: Tab[] };

beforeEach(() => {
  mocks.events.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  host = observable({ resolvedTabs: [] as Tab[] }, { resolvedTabs: observable.ref });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function draw(tabs: Tab[]) {
  runInAction(() => {
    host.resolvedTabs = tabs;
  });
  const TabContent = FileTabContent;
  await act(async () => {
    root.render(<TabContent host={host as never} ctx={{} as never} />);
  });
}

/** 把活动页签换成 `tabId`(页签条点一下)。 */
async function activate(tabId: string) {
  await act(async () => {
    runInAction(() => {
      host.resolvedTabs = host.resolvedTabs.map((t) => ({ ...t, isActive: t.tabId === tabId }));
    });
  });
}

const layer = (path: string) => container.querySelector(`[data-preview="${path}"]`)?.parentElement ?? null;
// 藏 = content-visibility:hidden(lib/retainedSurface.ts):看不见、拿不到焦点、find 找不到。
const shown = (path: string) => {
  const el = container.querySelector<HTMLElement>(`[data-preview="${path}"]`);
  return el !== null && el.checkVisibility({ visibilityProperty: true });
};
const focusable = (path: string) => {
  const button = container.querySelector<HTMLButtonElement>(`[data-preview="${path}"] button`)!;
  button.focus();
  const landed = document.activeElement === button;
  button.blur();
  return landed;
};
const findable = (text: string) => {
  window.getSelection()?.removeAllRanges();
  return (window as unknown as { find: (text: string) => boolean }).find(text);
};

describe('a file tab inside a retained session page that is not on screen', () => {
  it('paints nothing — neither the source nor the preview inherits anything but hidden', async () => {
    runInAction(() => {
      host.resolvedTabs = [{ ...fileTab('/w/a.html'), isActive: true }];
    });
    const TabContent = FileTabContent;
    await act(async () => {
      root.render(
        <div style={RETAINED_SURFACE_HIDDEN_STYLE}>
          <TabContent host={host as never} ctx={{} as never} />
        </div>
      );
    });
    expect(container.querySelector('[data-preview="/w/a.html"]')).not.toBeNull();
    // 藏起来的是面里的内容;面自己的盒子(没有底色、不接点击)留在原位占住尺寸。
    const surface = container.firstElementChild!;
    const painted = [...surface.querySelectorAll('*')].filter((el) => el.checkVisibility({ visibilityProperty: true }));
    expect(painted.map((el) => el.outerHTML.slice(0, 120))).toEqual([]);
    expect(focusable('/w/a.html')).toBe(false);
    expect(findable('/w/a.html preview')).toBe(false);
  });
});

describe('a file preview tab, switched away from and back', () => {
  it('keeps the page it was showing: switching between file tabs mounts each preview once', async () => {
    const a = fileTab('/w/a.html');
    const b = fileTab('/w/b.html');
    await draw([{ ...a, isActive: true }, b]);
    expect(mocks.events).toEqual(['mount /w/a.html']);

    await activate(b.tabId);
    await activate(a.tabId);
    await activate(b.tabId);
    expect(mocks.events).toEqual(['mount /w/a.html', 'mount /w/b.html']);
    expect(shown('/w/b.html')).toBe(true);
    expect(focusable('/w/b.html')).toBe(true);
    expect(findable('/w/b.html preview')).toBe(true);
    expect(shown('/w/a.html')).toBe(false);
    expect(focusable('/w/a.html')).toBe(false);
    expect(findable('/w/a.html preview')).toBe(false);
  });

  it('keeps it while a tab of another kind is in front, and shows none of it there', async () => {
    const a = fileTab('/w/a.html');
    await draw([{ ...a, isActive: true }, browserTab]);
    await activate(browserTab.tabId);
    expect(mocks.events).toEqual(['mount /w/a.html']);
    expect(shown('/w/a.html')).toBe(false);
    // 版面照常摆着(工具栏还在),藏着的预览尺寸不变,切回来不重排。
    expect(container.querySelector('[data-toolbar]')).not.toBeNull();

    await activate(a.tabId);
    expect(mocks.events).toEqual(['mount /w/a.html']);
    expect(shown('/w/a.html')).toBe(true);
  });

  it('releases the page when its tab closes', async () => {
    const a = fileTab('/w/a.html');
    const b = fileTab('/w/b.html');
    await draw([{ ...a, isActive: true }, b]);
    await activate(b.tabId);
    await act(async () => {
      runInAction(() => {
        host.resolvedTabs = host.resolvedTabs.filter((t) => t.tabId !== a.tabId);
      });
    });
    expect(mocks.events).toEqual(['mount /w/a.html', 'mount /w/b.html', 'unmount /w/a.html']);
  });

  it('does not load a restored tab nobody has looked at yet', async () => {
    const a = fileTab('/w/a.html');
    const b = fileTab('/w/b.html');
    const c = fileTab('/w/c.html');
    await draw([{ ...a, isActive: true }, b, c]);
    await activate(b.tabId);
    expect(mocks.events).toEqual(['mount /w/a.html', 'mount /w/b.html']);
    expect(layer('/w/c.html')).toBeNull();
  });

  // owner 同日:「这样不是会让内存爆炸吗」—— 每页预览是一个渲染进程(mac1 实测约 100MB),所以封了顶。
  it(`keeps at most ${KEPT_HIDDEN_PREVIEWS} hidden pages: the least recently viewed is released, and reloads when visited again`, async () => {
    const tabs = Array.from({ length: KEPT_HIDDEN_PREVIEWS + 2 }, (_, i) => fileTab(`/w/p${i}.html`));
    await draw([{ ...tabs[0], isActive: true }, ...tabs.slice(1)]);
    for (const t of tabs.slice(1)) await activate(t.tabId);
    // p0 是最久没看的那页:最后一页一显示,它就超出了封顶。
    const mounts = tabs.map((t) => `mount ${t.resource.path}`);
    expect(mocks.events).toEqual([...mounts.slice(0, -1), 'unmount /w/p0.html', mounts.at(-1)]);
    expect(tabs.filter((t) => layer(t.resource.path)).length).toBe(KEPT_HIDDEN_PREVIEWS + 1);

    mocks.events.length = 0;
    await activate(tabs[0].tabId);
    // 回到 p0:重新挂上;让位的是此刻最久没看的 p1。
    expect(mocks.events).toEqual(['unmount /w/p1.html', 'mount /w/p0.html']);
  });

  it('releases the page when the tab switches to source — the preview then follows the buffer afresh', async () => {
    const a = fileTab('/w/a.html');
    await draw([{ ...a, isActive: true }]);
    await act(async () => {
      runInAction(() => {
        a.resource.viewMode = 'source';
      });
    });
    expect(mocks.events).toEqual(['mount /w/a.html', 'unmount /w/a.html']);
  });
});
