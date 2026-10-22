import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7274 页签的网页是主进程持有的 WebContentsView。这里钉住它在窗口里的样子随页签走:
 * 露着挂在窗口上;被界面浮层盖住 / 不在屏上就停进那扇窗的停放窗(从不显示、大小照旧 —— agent 在后台操作它时
 * 视口对、截得到图);页签挪走留一会儿、关了当场收,界面整页重载 / 窗关了一并收;
 * 以及盖在它上面那扇 agent 浮窗点不着、跟着网页摆。
 */

const state = vi.hoisted(() => ({
  views: [] as any[],
  windows: [] as any[],
  emitted: [] as any[],
  registered: new Map<string, string>(),
  adopted: [] as Array<{ browserId: string; placement: { window: () => unknown; origin: () => { x: number; y: number } } }>,
  parkings: [] as any[],
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeWebContents extends Emitter {
    static nextId = 100;
    id = FakeWebContents.nextId++;
    destroyed = false;
    url = '';
    loaded: string[] = [];
    zoom = 1;
    navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} };
    isDestroyed() {
      return this.destroyed;
    }
    getURL() {
      return this.url;
    }
    getTitle() {
      return 'title';
    }
    loadURL(url: string) {
      this.loaded.push(url);
      this.url = url;
      return Promise.resolve();
    }
    setVisualZoomLevelLimits() {
      return Promise.resolve();
    }
    setZoomFactor(factor: number) {
      this.zoom = factor;
    }
    close() {
      this.destroyed = true;
      this.emit('destroyed');
    }
  }
  class WebContentsView {
    webContents = new FakeWebContents();
    bounds: unknown = null;
    background = '';
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      state.views.push(this);
    }
    setBounds(bounds: unknown) {
      this.bounds = bounds;
    }
    setBackgroundColor(color: string) {
      this.background = color;
    }
  }
  /** 停放窗:记下它的选项、内容区、挂在里面的网页;❌ 有 show。 */
  class BaseWindow {
    destroyed = false;
    contentBounds: unknown = null;
    children: unknown[] = [];
    contentView = {
      addChildView: (view: unknown) => {
        this.children = [...this.children.filter((v) => v !== view), view];
      },
      removeChildView: (view: unknown) => {
        this.children = this.children.filter((v) => v !== view);
      },
    };
    constructor(readonly options: Record<string, unknown>) {
      state.parkings.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
    setContentBounds(bounds: unknown) {
      this.contentBounds = bounds;
    }
  }
  return {
    WebContentsView,
    BaseWindow,
    BrowserWindow: { getAllWindows: () => state.windows },
    app: new Emitter(),
  };
});

function fakeWindow(name = '', zoom = 1) {
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    visible: true,
    minimized: false,
    /** 人正看着咕咕(前台窗口)。 */
    focused: true,
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible;
    },
    isFocused() {
      return this.focused;
    },
    isMinimized() {
      return this.minimized;
    },
    getMediaSourceId: () => 'window:101:0',
    children: [] as unknown[],
    contentView: {
      addChildView(view: unknown) {
        window.children = [...window.children.filter((v) => v !== view), view];
      },
      removeChildView(view: unknown) {
        window.children = window.children.filter((v) => v !== view);
      },
    },
    webContents: Object.assign(new EventEmitter(), {
      mainFrame: { name },
      getZoomFactor: () => zoom,
      focus: vi.fn(),
    }),
    getContentSize: () => [1200, 800],
    getContentBounds: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
  });
  return window;
}

let mainWindow = fakeWindow();
vi.mock('@main/app/window', () => ({ getMainWindow: () => mainWindow }));
vi.mock('@main/lib/events', () => ({ events: { emit: (_channel: unknown, payload: unknown) => state.emitted.push(payload) } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../../devtools-lock', () => ({ hardenWebPreferences: <T>(prefs: T) => prefs }));
vi.mock('./browser-webcontents-registry', () => ({
  browserWebContentsRegistry: {
    get registeredPartitions() {
      return new Set(state.registered.values());
    },
    isRegistered: (browserId: string, partition: string) => state.registered.get(browserId) === partition,
    adoptPageWebContents: (browserId: string, _webContents: unknown, placement: (typeof state.adopted)[number]['placement']) =>
      state.adopted.push({ browserId, placement }),
  },
}));

import {
  destroyBrowserPage,
  layoutBrowserPage,
  mountBrowserPage,
  releaseBrowserPage,
  setAgentOverlayInteractive,
  snapshotBrowserPage,
  toDip,
} from './browser-page-views';

const PARTITION = 'persist:gugu-browser-profile';
const RECT = { x: 804, y: 81, width: 476, height: 819 };

function mount(browserId: string, url = 'https://example.com', windowName = '') {
  state.registered.set(browserId, PARTITION);
  const result = mountBrowserPage({ browserId, partition: PARTITION, url, windowName });
  return { result, view: state.views.at(-1) };
}

beforeEach(() => {
  mainWindow = fakeWindow();
  state.windows = [mainWindow];
  state.views.length = 0;
  state.emitted.length = 0;
  state.adopted.length = 0;
  state.registered.clear();
  state.parkings.length = 0;
});

/** 这扇窗的停放窗(还没建过就是 undefined)。 */
const parking = () => state.parkings.at(-1);
afterEach(() => {
  for (const browserId of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']) destroyBrowserPage(browserId);
  vi.useRealTimers();
});

describe('#7274 建网页', () => {
  it('收紧过的独立 view:沙盒、不嵌 webview、换页不抢焦点;载入页签的首个地址', () => {
    const { result, view } = mount('b1');
    expect(result).toMatchObject({ success: true, reused: false });
    expect(view.options.webPreferences).toMatchObject({
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      focusOnNavigation: false,
    });
    expect(view.webContents.loaded).toEqual(['https://example.com/']);
    expect(state.adopted.map((a) => a.browserId)).toEqual(['b1']);
  });

  it('没登记的页签、不支持的地址:不建', () => {
    expect(mountBrowserPage({ browserId: 'b2', partition: PARTITION, url: 'https://a.test', windowName: '' })).toMatchObject({ success: false });
    state.registered.set('b2', PARTITION);
    expect(mountBrowserPage({ browserId: 'b2', partition: PARTITION, url: 'javascript:alert(1)', windowName: '' })).toMatchObject({
      success: false,
      error: 'unsupported-url',
    });
    expect(state.views).toHaveLength(0);
  });
});

describe('#7274 网页在窗口里的样子跟着页签走', () => {
  it('露着:挂到窗口上、摆在页签那一块(界面缩放换成窗口 DIP)', () => {
    mainWindow = fakeWindow('', 1.25);
    state.windows = [mainWindow];
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(mainWindow.children).toContain(view);
    expect(view.bounds).toEqual(toDip(RECT, 1.25));
  });

  it('停放窗:从不显示、不能聚焦、不进任务栏,内容区和那扇窗一样大;窗挪动 / 改大小跟着', () => {
    mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'background' });
    expect(parking().options).toMatchObject({ show: false, focusable: false, skipTaskbar: true, frame: false });
    expect(parking().contentBounds).toEqual({ x: 100, y: 50, width: 1200, height: 800 });
    mainWindow.getContentBounds = () => ({ x: 0, y: 0, width: 900, height: 700 });
    mainWindow.emit('resize');
    expect(parking().contentBounds).toEqual({ x: 0, y: 0, width: 900, height: 700 });
  });

  it('从没露过面的页签(人在别的会话里):建好就停进停放窗、大小跟着页签 —— agent 在后台操作它时视口是对的', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'background' });
    expect(parking().children).toContain(view);
    expect(mainWindow.children).not.toContain(view);
    expect(view.bounds).toEqual(RECT);
  });

  it('被界面浮层盖住:停进停放窗、大小不变;浮层走了挂回窗口', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'occluded' });
    expect(mainWindow.children).not.toContain(view);
    expect(parking().children).toContain(view);
    expect(view.bounds).toEqual(RECT);
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(mainWindow.children).toContain(view);
    expect(parking().children).not.toContain(view);
  });

  it('切到后台:停进停放窗;大小仍跟着页签(窗口改了大小,后台的网页也跟着)', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: { ...RECT, width: 500 }, mode: 'background' });
    expect(mainWindow.children).not.toContain(view);
    expect(parking().children).toContain(view);
    expect(view.bounds).toEqual({ ...RECT, width: 500 });
  });

  it('一扇窗只配一扇停放窗', () => {
    mount('b1');
    mount('b2');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'background' });
    layoutBrowserPage({ browserId: 'b2', windowName: '', rect: RECT, mode: 'occluded' });
    expect(state.parkings).toHaveLength(1);
  });

  it('截图(浮层压上来时换上的那张):从没摆好过的网页不截(视口 0×0,Chromium 会一直等)', async () => {
    mount('b1');
    expect(await snapshotBrowserPage('b1')).toBeNull();
  });

  it('网页要全屏(视频):铺满窗口内容区、叠到最上面(分栏的另一张网页压不着它);退出回到页签那一块', () => {
    const { view } = mount('b1');
    const other = mount('b2').view;
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    layoutBrowserPage({ browserId: 'b2', windowName: '', rect: { ...RECT, x: 0 }, mode: 'shown' });
    view.webContents.emit('enter-html-full-screen');
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
    expect(mainWindow.children.at(-1)).toBe(view);
    expect(mainWindow.children).toContain(other);
    view.webContents.emit('leave-html-full-screen');
    expect(view.bounds).toEqual(RECT);
  });

  it('右键菜单的落点:网页左上角在窗口里的位置(全屏时是窗口原点)', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    const placement = state.adopted.at(-1)!.placement;
    expect(placement.window()).toBe(mainWindow);
    expect(placement.origin()).toEqual({ x: 804, y: 81 });
    view.webContents.emit('enter-html-full-screen');
    expect(placement.origin()).toEqual({ x: 0, y: 0 });
  });

  it('单独成窗:挂到名字对得上的那扇窗上', () => {
    const aux = fakeWindow('gugu-aux:7');
    state.windows = [mainWindow, aux];
    const { view } = mount('b1', 'https://example.com', 'gugu-aux:7');
    layoutBrowserPage({ browserId: 'b1', windowName: 'gugu-aux:7', rect: RECT, mode: 'shown' });
    expect(aux.children).toContain(view);
    expect(mainWindow.children).not.toContain(view);
  });
});

describe('#7274 生命周期', () => {
  it('页签挪了位置:先停进停放窗、留着;在新位置挂回来接着用原来那张(❌ 重新载入)', () => {
    vi.useFakeTimers();
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    releaseBrowserPage('b1');
    expect(mainWindow.children).not.toContain(view);
    expect(parking().children).toContain(view);
    vi.advanceTimersByTime(1_000);
    const again = mountBrowserPage({ browserId: 'b1', partition: PARTITION, url: 'https://other.test', windowName: '' });
    expect(again).toMatchObject({ success: true, reused: true });
    expect(state.views).toHaveLength(1);
    expect(view.webContents.loaded).toEqual(['https://example.com/']);
    vi.advanceTimersByTime(10_000);
    expect(view.webContents.destroyed).toBe(false);
  });

  it('卸下后没人再要:过一会儿关掉', () => {
    vi.useFakeTimers();
    const { view } = mount('b1');
    releaseBrowserPage('b1');
    vi.advanceTimersByTime(5_100);
    expect(view.webContents.destroyed).toBe(true);
  });

  it('页签关了:网页当场关掉、从窗口 / 停放窗上摘下;之后的布局请求不再碰它', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    destroyBrowserPage('b1');
    expect(view.webContents.destroyed).toBe(true);
    expect(mainWindow.children).not.toContain(view);
    const parked = mount('b2').view;
    layoutBrowserPage({ browserId: 'b2', windowName: '', rect: RECT, mode: 'background' });
    destroyBrowserPage('b2');
    expect(parking().children).not.toContain(parked);
    expect(layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' })).toBe(false);
  });

  it('界面整页重载:这扇窗上的网页一并关掉(❌ 留一块没人管的网页盖在新界面上)', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    mainWindow.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(view.webContents.destroyed).toBe(true);
  });

  it('单独成窗的那扇关了:网页先放手、留一会儿(页签挪回主窗接着用),没人要就关掉;它的停放窗一并关掉', () => {
    vi.useFakeTimers();
    const aux = fakeWindow('gugu-aux:7');
    state.windows = [mainWindow, aux];
    const kept = mount('b1', 'https://example.com', 'gugu-aux:7').view;
    const dropped = mount('b2', 'https://example.com', 'gugu-aux:7').view;
    layoutBrowserPage({ browserId: 'b1', windowName: 'gugu-aux:7', rect: RECT, mode: 'shown' });
    layoutBrowserPage({ browserId: 'b2', windowName: 'gugu-aux:7', rect: RECT, mode: 'background' });
    const auxParking = parking();
    aux.destroyed = true;
    aux.emit('closed');
    expect(auxParking.destroyed).toBe(true);
    mountBrowserPage({ browserId: 'b1', partition: PARTITION, url: 'https://example.com', windowName: '' });
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    vi.advanceTimersByTime(5_100);
    expect(mainWindow.children).toContain(kept);
    expect(kept.webContents.destroyed).toBe(false);
    expect(dropped.webContents.destroyed).toBe(true);
  });

  it('网页自己没了(崩溃回收):不再记着它', () => {
    const { view } = mount('b1');
    view.webContents.close();
    expect(layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' })).toBe(false);
  });
});

describe('#7274 网页事件报给页签(带着此刻的导航状态)', () => {
  it('子框架的失败 / 页内跳转不算整页的;console 级别换成原先 webview 的数字', () => {
    const { view } = mount('b1');
    const wc = view.webContents;
    wc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://ads.test/', false);
    wc.emit('did-navigate-in-page', {}, 'https://ads.test/#x', false);
    expect(state.emitted).toHaveLength(0);
    wc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://example.com/', true);
    wc.emit('console-message', { level: 'warning', message: 'm', lineNumber: 3, sourceId: 's' });
    expect(state.emitted.map((e) => [e.type, e.detail])).toEqual([
      ['did-fail-load', { errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED', validatedURL: 'https://example.com/' }],
      ['console-message', { level: 2, message: 'm', line: 3, sourceId: 's' }],
    ]);
    expect(state.emitted[0].state).toMatchObject({ url: 'https://example.com/', canGoBack: false });
  });
});

describe('#7274 盖在网页上的 agent 浮窗', () => {
  function overlayWindow() {
    return Object.assign(new EventEmitter(), {
      destroyed: false,
      visible: false,
      bounds: null as unknown,
      ignore: [] as unknown[][],
      isDestroyed() {
        return this.destroyed;
      },
      isVisible() {
        return this.visible;
      },
      showInactive: vi.fn(function (this: { visible: boolean }) {
        this.visible = true;
      }),
      moveAbove: vi.fn(function (this: { visible: boolean }, _sourceId: string) {
        this.visible = true;
      }),
      setParentWindow: vi.fn(),
      hide() {
        this.visible = false;
      },
      close() {
        this.destroyed = true;
      },
      setBounds(bounds: unknown) {
        this.bounds = bounds;
      },
      setIgnoreMouseEvents(...args: unknown[]) {
        this.ignore.push(args);
      },
    });
  }

  it.each(['darwin', 'win32', 'linux'])('%s: 浮层挂成真正的子窗露出,不把父窗提到别的 App 前面', (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    try {
      mainWindow.focused = false; // 咕咕不在前台
      mount('b1');
      layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
      const overlay = overlayWindow();
      mainWindow.webContents.emit('did-create-window', overlay, { frameName: 'gugu-agent-overlay:b1' });
      if (platform === 'darwin') {
        // #77 showInactive 会把咕咕提到别的 App 前面 ⇒ 先不露,等人回到咕咕;❌ moveAbove 顶替(挂不成子窗,父窗一提前就沉下去)。
        expect(overlay.visible).toBe(false);
        mainWindow.focused = true;
        mainWindow.emit('focus');
        expect(overlay.setParentWindow).toHaveBeenCalledWith(mainWindow);
      }
      expect(overlay.showInactive).toHaveBeenCalledOnce();
      expect(overlay.visible).toBe(true);
      expect(overlay.moveAbove).not.toHaveBeenCalled();
      expect(mainWindow.webContents.focus).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('父窗隐藏 / 最小化时浮层收起;再露面 / 还原时接着显示', () => {
    mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    const overlay = overlayWindow();
    mainWindow.webContents.emit('did-create-window', overlay, { frameName: 'gugu-agent-overlay:b1' });
    mainWindow.visible = false;
    mainWindow.emit('hide');
    expect(overlay.visible).toBe(false);
    mainWindow.visible = true;
    mainWindow.emit('show');
    expect(overlay.visible).toBe(true);
    mainWindow.minimized = true;
    mainWindow.emit('minimize');
    expect(overlay.visible).toBe(false);
    mainWindow.minimized = false;
    mainWindow.emit('restore');
    expect(overlay.visible).toBe(true);
  });

  it('点不着(鼠标穿过去,移动照报)、摆在网页那一块的屏幕位置、只在网页露着时显示;指着小条时才接住点击', () => {
    mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    const overlay = overlayWindow();
    mainWindow.webContents.emit('did-create-window', overlay, { frameName: 'gugu-agent-overlay:b1' });
    expect(overlay.ignore[0]).toEqual([true, { forward: true }]);
    expect(overlay.bounds).toEqual({ x: 100 + 804, y: 50 + 81, width: 476, height: 819 });
    expect(overlay.visible).toBe(true);
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'occluded' });
    expect(overlay.visible).toBe(false);
    setAgentOverlayInteractive('b1', true);
    expect(overlay.ignore.at(-1)).toEqual([false]);
    setAgentOverlayInteractive('b1', false);
    expect(overlay.ignore.at(-1)).toEqual([true, { forward: true }]);
  });

  it('没有对应网页的浮窗:关掉', () => {
    mount('b2');
    const overlay = overlayWindow();
    mainWindow.webContents.emit('did-create-window', overlay, { frameName: 'gugu-agent-overlay:missing' });
    expect(overlay.destroyed).toBe(true);
  });
});
