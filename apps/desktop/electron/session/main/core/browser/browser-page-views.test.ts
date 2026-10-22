import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7274 页签的网页是主进程持有的 WebContentsView。这里钉住它在窗口里的样子随页签走:
 * 露着挂在窗口上;被界面浮层盖住 / 不在屏上就停进那扇窗的停放窗(从不显示、大小照旧 —— agent 在后台操作它时
 * 视口对、截得到图);页签挪走留一会儿、关了当场收,界面整页重载 / 窗关了一并收;
 * 以及盖在它上面的 agent 鼠标、小条两层(窗口里的层,❌ 子窗)跟着网页摆、叠在网页上面。
 */

const state = vi.hoisted(() => ({
  views: [] as any[],
  windows: [] as any[],
  emitted: [] as any[],
  registered: new Map<string, string>(),
  adopted: [] as Array<{ browserId: string; placement: { window: () => unknown; origin: () => { x: number; y: number } } }>,
  parkings: [] as any[],
  boxes: [] as Array<{ parent: unknown; options: any }>,
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
    // 照 Electron v44:网页的 JS 对话框走这两个内部事件(browser-page-dialogs.ts 接管)。
    debugger = Object.assign(new Emitter(), { isAttached: () => false });
    constructor() {
      super();
      this.on('-run-dialog', () => {});
      this.on('-cancel-dialogs', () => {});
    }
    close() {
      this.destroyed = true;
      this.emit('destroyed');
    }
  }
  class WebContentsView {
    webContents: FakeWebContents;
    bounds: unknown = null;
    background = '';
    visible = true;
    constructor(readonly options: { webPreferences?: Record<string, unknown>; webContents?: FakeWebContents }) {
      this.webContents = options.webContents ?? new FakeWebContents();
      state.views.push(this);
    }
    setBounds(bounds: unknown) {
      this.bounds = bounds;
    }
    setVisible(visible: boolean) {
      this.visible = visible;
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
    dialog: {
      showMessageBox: (parent: unknown, options: any) => {
        state.boxes.push({ parent, options });
        return new Promise(() => {});
      },
    },
  };
});

function fakeWindow(name = '', zoom = 1) {
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    visible: true,
    minimized: false,
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible;
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
  closeAgentOverlayLayers,
  setAgentCursorShown,
  snapshotBrowserPage,
  toDip,
  visibleHostOfPage,
} from './browser-page-views';
import { windowLayerResponse } from '../../../../window-layers';

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
  state.boxes.length = 0;
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

  it('#72 停着的网页弹 alert:什么窗都不出(❌ 挂到停放窗上);页签露出来、窗露着才挂到那扇窗上', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'background' });
    const callback = vi.fn();
    view.webContents.emit('-run-dialog', { dialogType: 'alert', messageText: 'saved' }, callback);
    expect(callback).toHaveBeenCalledWith(true, '');
    expect(state.boxes).toHaveLength(0);
    mainWindow.visible = false;
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(state.boxes).toHaveLength(0);
    mainWindow.visible = true;
    mainWindow.emit('show');
    expect(state.boxes).toHaveLength(1);
    expect(state.boxes[0]).toMatchObject({ parent: mainWindow, options: { message: 'saved' } });
  });

  it('#72 停着的网页弹的 alert:切回这个页签(窗一直露着)就挂到那扇窗上', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'background' });
    view.webContents.emit('-run-dialog', { dialogType: 'alert', messageText: 'later' }, vi.fn());
    expect(state.boxes).toHaveLength(0);
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(state.boxes).toHaveLength(1);
    expect(state.boxes[0]).toMatchObject({ parent: mainWindow, options: { message: 'later' } });
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

  it('要当面问人一句(选通行密钥)时它露在哪扇窗:露着 → 那扇窗;停放 / 窗收起 / 最小化 → null;不是页签的网页 → undefined', () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    expect(visibleHostOfPage(view.webContents)).toBe(mainWindow);
    mainWindow.minimized = true;
    expect(visibleHostOfPage(view.webContents)).toBeNull();
    mainWindow.minimized = false;
    mainWindow.visible = false;
    expect(visibleHostOfPage(view.webContents)).toBeNull();
    mainWindow.visible = true;
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'occluded' });
    expect(visibleHostOfPage(view.webContents)).toBeNull();
    expect(visibleHostOfPage({} as never)).toBeUndefined();
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

describe('#77 盖在网页上的 agent 鼠标与小条:窗口里的两层', () => {
  /** 页签那边 window.open 开一层:主进程把那份内容装进窗口里的层(createWindow),❌ 新开窗口。 */
  async function openLayer(frameName: string, host = mainWindow) {
    const { WebContentsView } = await import('electron');
    const guest = new (WebContentsView as any)({}).webContents;
    state.views.pop();
    const response = windowLayerResponse(host as any, 'about:blank', frameName);
    expect(response).toMatchObject({ action: 'allow', overrideBrowserWindowOptions: { webPreferences: { sandbox: false } } });
    const webPreferences = { sandbox: false, enablePreferredSizeMode: true };
    expect(response!.createWindow({ webContents: guest, webPreferences } as any)).toBe(guest);
    const layer = state.views.at(-1);
    expect(layer.webContents).toBe(guest);
    // 接手现成内容时把 Electron 算好的网页设置原样带上(不带会被默认值整个覆盖)。
    expect(layer.options.webPreferences).toBe(webPreferences);
    return layer;
  }
  const PAGE = toDip(RECT, 1);

  it('两层装进开它们的那扇窗、叠在网页上面(小条在鼠标上面);后挂上的网页也压不住它们;不碰窗口焦点', async () => {
    const page = mount('b1').view;
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    const badge = await openLayer('gugu-agent-overlay:badge:1:b1');
    const cursor = await openLayer('gugu-agent-overlay:cursor:2:b1');
    expect(badge.background).toBe('#00000000');
    expect(mainWindow.children).toEqual([page, cursor, badge]);
    const other = mount('b2').view;
    layoutBrowserPage({ browserId: 'b2', windowName: '', rect: { ...RECT, x: 0 }, mode: 'shown' });
    expect(mainWindow.children).toEqual([page, other, cursor, badge]);
    expect(mainWindow.webContents.focus).not.toHaveBeenCalled();
  });

  it('小条那层按内容大小摆在网页底部正中;网页不露(被界面浮层盖住)就收起,露回来再摆上', async () => {
    mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    const badge = await openLayer('gugu-agent-overlay:badge:3:b1');
    expect(badge.visible).toBe(false);
    badge.webContents.emit('preferred-size-changed', {}, { width: 180.4, height: 40 });
    expect(badge.bounds).toEqual({ x: PAGE.x + Math.round((PAGE.width - 181) / 2), y: PAGE.y + PAGE.height - 40 - 4, width: 181, height: 40 });
    expect(badge.visible).toBe(true);
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'occluded' });
    expect(badge.visible).toBe(false);
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: { ...RECT, width: 600 }, mode: 'shown' });
    expect(badge.visible).toBe(true);
    expect(badge.bounds).toMatchObject({ x: PAGE.x + Math.round((600 - 181) / 2) });
  });

  it('鼠标那层铺满网页、只在页签那边画鼠标时露(它点不穿);网页全屏时收起', async () => {
    const { view } = mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    const cursor = await openLayer('gugu-agent-overlay:cursor:4:b1');
    expect(cursor.visible).toBe(false);
    setAgentCursorShown('b1', true);
    expect(cursor.bounds).toEqual(PAGE);
    expect(cursor.visible).toBe(true);
    view.webContents.emit('enter-html-full-screen');
    expect(cursor.visible).toBe(false);
    expect(mainWindow.children.at(-1)).toBe(cursor);
    view.webContents.emit('leave-html-full-screen');
    expect(cursor.visible).toBe(true);
    setAgentCursorShown('b1', false);
    expect(cursor.visible).toBe(false);
  });

  it('层的内容关了(页签那边收起)就从窗口上摘下;网页关了 / 换窗了,两层一并关掉', async () => {
    mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    const badge = await openLayer('gugu-agent-overlay:badge:5:b1');
    badge.webContents.close();
    expect(mainWindow.children).not.toContain(badge);
    const cursor = await openLayer('gugu-agent-overlay:cursor:6:b1');
    const again = await openLayer('gugu-agent-overlay:badge:7:b1');
    const aux = fakeWindow('gugu-aux:s1');
    state.windows = [mainWindow, aux];
    layoutBrowserPage({ browserId: 'b1', windowName: 'gugu-aux:s1', rect: RECT, mode: 'shown' });
    expect(cursor.webContents.destroyed).toBe(true);
    expect(again.webContents.destroyed).toBe(true);
    expect(mainWindow.children).not.toContain(cursor);
    const moved = await openLayer('gugu-agent-overlay:cursor:8:b1', aux);
    expect(aux.children.at(-1)).toBe(moved);
    destroyBrowserPage('b1');
    expect(moved.webContents.destroyed).toBe(true);
    expect(aux.children).not.toContain(moved);
  });

  it('没有对应网页、或网页不在开它的那扇窗上:那层关掉', async () => {
    mount('b2');
    const stray = await openLayer('gugu-agent-overlay:cursor:9:missing');
    const elsewhere = await openLayer('gugu-agent-overlay:badge:10:b2', fakeWindow('gugu-aux:s9'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stray.webContents.destroyed).toBe(true);
    expect(elsewhere.webContents.destroyed).toBe(true);
    expect(mainWindow.children).not.toContain(stray);
  });

  it('页签那边不要了:按名字关那一层,紧接着新开的(名字不同)不受影响', async () => {
    mount('b1');
    layoutBrowserPage({ browserId: 'b1', windowName: '', rect: RECT, mode: 'shown' });
    const old = await openLayer('gugu-agent-overlay:cursor:20:b1');
    const fresh = await openLayer('gugu-agent-overlay:cursor:21:b1');
    expect(old.webContents.destroyed).toBe(true);
    closeAgentOverlayLayers(['gugu-agent-overlay:cursor:20:b1', 'gugu-agent-overlay:badge:22:b1']);
    expect(fresh.webContents.destroyed).toBe(false);
    closeAgentOverlayLayers(['gugu-agent-overlay:cursor:21:b1']);
    expect(fresh.webContents.destroyed).toBe(true);
    expect(mainWindow.children).not.toContain(fresh);
  });

  it('不是 agent 浮层、也不是空白页的 window.open:不当层开', () => {
    expect(windowLayerResponse(mainWindow as any, 'https://example.com', 'gugu-agent-overlay:cursor:1:b1')).toBeNull();
    expect(windowLayerResponse(mainWindow as any, 'about:blank', 'gugu-aux:s1')).toBeNull();
    expect(windowLayerResponse(mainWindow as any, 'about:blank', 'gugu-agent-overlay:b1')).toBeNull();
    expect(windowLayerResponse(mainWindow as any, 'about:blank', 'gugu-agent-overlay:pill:1:b1')).toBeNull();
  });
});
