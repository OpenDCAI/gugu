import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { events } from '@main/lib/events';
import { browserAppShortcutChannel, tabNavigationShortcutChannel } from '@shared/events/appEvents';
import { browserFocusedChannel } from '@shared/events/browserEvents';
import { BrowserWebContentsRegistry, isSamePreviewNavigation } from './browser-webcontents-registry';

const sessionsByPartition = new Map<string, object>();

const menuPopups = vi.hoisted(() => [] as unknown[]);
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: () => ({ popup: (options: unknown) => menuPopups.push(options) }) },
  session: {
    fromPartition: (partition: string) => {
      let value = sessionsByPartition.get(partition);
      if (!value) {
        value = { partition, getUserAgent: () => 'base-ua', clearData: vi.fn() };
        sessionsByPartition.set(partition, value);
      }
      return value;
    },
  },
}));

vi.mock('@main/lib/events', () => ({
  events: {
    emit: vi.fn(),
  },
}));

const PROFILE_PARTITION = 'persist:gugu-browser-profile';

type FakeWebContents = WebContents & {
  windowOpenHandler: Parameters<WebContents['setWindowOpenHandler']>[0] | null;
  destroy(): void;
  emitEvent(event: string, ...args: unknown[]): void;
};

let nextWebContentsId = 1;

const PAGE_WINDOW = { id: 'host-window' };
/** #7274 页签的网页由主进程建好后交给登记表(browser-page-views.ts);网页左上角在窗口内容区 (40, 90)。 */
function adopt(registry: BrowserWebContentsRegistry, browserId: string, webContents: WebContents): void {
  registry.adoptPageWebContents(browserId, webContents, {
    window: () => PAGE_WINDOW as never,
    origin: () => ({ x: 40, y: 90 }),
  });
}

function fakeWebContents(partition: string = PROFILE_PARTITION): FakeWebContents {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const fake = {
    id: nextWebContentsId++,
    session: sessionFor(partition),
    windowOpenHandler: null as FakeWebContents['windowOpenHandler'],
    close: vi.fn(),
    isDestroyed: () => false,
    getURL: () => 'https://example.com',
    getUserAgent: () => 'base-ua',
    setUserAgent: vi.fn(),
    openDevTools: vi.fn(),
    setWindowOpenHandler(handler: FakeWebContents['windowOpenHandler']) {
      fake.windowOpenHandler = handler;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return fake;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return fake;
    },
    destroy() {
      for (const listener of listeners.get('destroyed') ?? []) listener();
    },
    emitEvent(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
  return fake as unknown as FakeWebContents;
}

function sessionFor(partition: string): object {
  let value = sessionsByPartition.get(partition);
  if (!value) {
    value = { partition, getUserAgent: () => 'base-ua', clearData: vi.fn() };
    sessionsByPartition.set(partition, value);
  }
  return value;
}

/**
 * `Mod+K` 在实现里由 `process.platform` 决定落到哪个修饰键(darwin → meta,其余 → control,
 * 见 browser-webcontents-registry.ts 的 parse)。原先这两条只按 `meta: true` 敲,
 * 于是**同一棵树在 mac 上绿、在 Linux 上红** —— CI 跑 mac 一直绿,开发机是 Linux 一直红。
 *
 * 而「不该触发」那条更阴:在 Linux 上它是**因为压根没按对键**而变绿的,
 * 不是因为「这个快捷键被禁用了」。阴性判据为错误的理由变绿 = 它其实什么都没守。
 *
 * ⇒ 两个平台各跑一遍,各按各的真实修饰键。
 */
const MOD_PLATFORMS = [
  { platform: 'darwin', mod: { meta: true, control: false } },
  { platform: 'linux', mod: { meta: false, control: true } },
] as const

/**
 * ⚠️ 平台在**两个地方**各判一次,桩一个不够:
 *  · `parseShortcut`(本文件被测实现)读 `process.platform`,决定 Mod 落到 meta 还是 control;
 *  · `detectShortcutPlatform`(shortcuts.ts)**先读 `navigator`**、`process.platform` 只是兜底,
 *    决定 defaultHotkey 那一族。Node 24 自带 navigator,在 Linux 上报 'Linux x86_64' ——
 *    只桩 process.platform 会被它盖过去,桩了等于没桩。
 *
 * ⚠️ 用 `vi.stubGlobal` 而不是自己 `defineProperty(globalThis, 'navigator', …)`:
 * 后者还原时会把原本的访问器属性写成数据属性,在共用 worker 的测试之间留下痕迹。
 * vitest 自己的桩有明确的还原语义,并由下面的 afterEach 兜底。
 */
function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const originalProcess = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  vi.stubGlobal('navigator', {
    platform: platform === 'darwin' ? 'MacIntel' : 'Linux x86_64',
    userAgent: platform,
  })
  try {
    return run()
  } finally {
    if (originalProcess) Object.defineProperty(process, 'platform', originalProcess)
    vi.unstubAllGlobals()
  }
}

describe('BrowserWebContentsRegistry', () => {
  beforeEach(() => {
    sessionsByPartition.clear();
    vi.mocked(events.emit).mockClear();
  });

  // withPlatform 自己在 finally 里还原;这条是兜底 —— 用例中途抛出时,
  // 桩不能留给同一个 worker 里的下一个文件。
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('#7274 认得出页签登记过、用的是哪份配置(建网页之前核对)', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
    expect(registry.isRegistered('browser-1', PROFILE_PARTITION)).toBe(true);
    expect(registry.isRegistered('browser-1', 'persist:gugu-browser-profile-work')).toBe(false);
    expect(registry.isRegistered('missing', PROFILE_PARTITION)).toBe(false);
  });

  it('#7274 同一份配置上的几张网页各归各的页签', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
    registry.registerSession({ browserId: 'browser-2', partition: PROFILE_PARTITION });

    const first = fakeWebContents();
    const second = fakeWebContents();
    adopt(registry, 'browser-1', first);
    adopt(registry, 'browser-2', second);

    expect(registry.openDevTools('browser-1')).toBe(true);
    expect(first.openDevTools).toHaveBeenCalled();
    expect(registry.getActiveBrowser()).toBeNull();
    expect(registry.browserIdFor(second.id)).toBe('browser-2');
  });

  it('#7274 右键菜单弹在网页所在的窗口上,坐标换成窗口内容区的(网页自己的坐标 + 网页左上角)', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
    const webContents = fakeWebContents();
    adopt(registry, 'browser-1', webContents);
    menuPopups.length = 0;
    webContents.emitEvent('context-menu', { preventDefault: vi.fn() }, { x: 5, y: 7, selectionText: 'hi', linkURL: '', srcURL: '', mediaType: 'none' });
    expect(menuPopups).toEqual([{ window: PAGE_WINDOW, x: 45, y: 97 }]);
  });

  it('allows OAuth popups as hardened windows and routes tab links in-app', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    adopt(registry, 'browser-1', webContents);

    const handler = webContents.windowOpenHandler!;
    const popup = handler({
      url: 'https://github.com/login/oauth/authorize',
      disposition: 'new-window',
    } as Parameters<typeof handler>[0]);
    expect(popup.action).toBe('allow');
    expect(popup).toMatchObject({
      overrideBrowserWindowOptions: {
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      },
    });

    const tab = handler({
      url: 'https://example.com/docs',
      disposition: 'foreground-tab',
    } as Parameters<typeof handler>[0]);
    expect(tab.action).toBe('deny');
    expect(events.emit).toHaveBeenCalledWith(expect.anything(), {
      sourceBrowserId: 'browser-1',
      url: 'https://example.com/docs',
    });

    const windowOpen = handler({
      url: 'https://example.com/popup',
      disposition: 'new-window',
    } as Parameters<typeof handler>[0]);
    expect(windowOpen.action).toBe('deny');
    expect(events.emit).toHaveBeenCalledWith(expect.anything(), {
      sourceBrowserId: 'browser-1',
      url: 'https://example.com/popup',
    });

    const blocked = handler({
      url: 'javascript:alert(1)',
      disposition: 'new-window',
    } as Parameters<typeof handler>[0]);
    expect(blocked.action).toBe('deny');
  });

  it('switches popup webContents user agent during Google auth navigations', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
    const webContents = fakeWebContents();
    const popupWebContents = fakeWebContents();

    adopt(registry, 'browser-1', webContents);
    webContents.emitEvent('did-create-window', { webContents: popupWebContents });
    popupWebContents.emitEvent(
      'did-start-navigation',
      {},
      'https://accounts.google.com/signin',
      false,
      true
    );

    expect(popupWebContents.setUserAgent).toHaveBeenCalledWith(
      expect.stringContaining('Firefox/140.0')
    );
  });

  it('cleans up bindings when the webContents is destroyed', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    adopt(registry, 'browser-1', webContents);
    registry.setActiveBrowser('browser-1');
    expect(registry.getActiveBrowser()).toBe('browser-1');

    webContents.destroy();

    expect(registry.getActiveBrowser()).toBeNull();
    expect(registry.openDevTools('browser-1')).toBe(false);
  });

  it('#7323 restoring an unmounted page does not select it or change which tab its session prefers', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'original', partition: PROFILE_PARTITION, sessionId: 's' });
    registry.registerSession({ browserId: 'other', partition: PROFILE_PARTITION, sessionId: 's' });
    const original = fakeWebContents();
    adopt(registry, 'original', original);
    registry.setActiveBrowser('original');
    original.destroy();
    expect(registry.preferredBrowserOfSession('s')).toBe('original');
    adopt(registry, 'other', fakeWebContents());
    expect(registry.getActiveBrowser()).toBeNull();
    expect(registry.preferredBrowserOfSession('s')).toBe('original');
    expect(registry.browsersOfSession('s').map((p) => p.browserId)).toEqual(['other']);
  });

  it('tells the renderer which browser got focus (a click inside the page never reaches the host)', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
    const webContents = fakeWebContents();
    adopt(registry, 'browser-1', webContents);
    // 只是划过去不算。
    webContents.emitEvent('before-mouse-event', {}, { type: 'mouseMove', x: 1, y: 1 });
    expect(events.emit).not.toHaveBeenCalledWith(browserFocusedChannel, expect.anything());
    webContents.emitEvent('before-mouse-event', {}, { type: 'mouseDown', x: 1, y: 1 });
    expect(events.emit).toHaveBeenCalledWith(browserFocusedChannel, { browserId: 'browser-1' });
  });

  it('#7274 agent 自己合成的点击不让页签焦点跟过去(❌ 把人正看着的页签换掉)', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
    const webContents = fakeWebContents();
    adopt(registry, 'browser-1', webContents);
    let agentsOwn = true;
    const observer = vi.fn(() => agentsOwn);
    registry.setMouseDownObserver(observer);

    webContents.emitEvent('before-mouse-event', {}, { type: 'mouseDown', x: 1, y: 1 });
    expect(observer).toHaveBeenCalledWith('browser-1', webContents);
    expect(events.emit).not.toHaveBeenCalledWith(browserFocusedChannel, expect.anything());

    agentsOwn = false;
    webContents.emitEvent('before-mouse-event', {}, { type: 'mouseDown', x: 1, y: 1 });
    expect(events.emit).toHaveBeenCalledWith(browserFocusedChannel, { browserId: 'browser-1' });
    registry.setMouseDownObserver(null);
  });

  it('emits tab navigation shortcuts from focused browser webContents', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    adopt(registry, 'browser-1', webContents);

    const keyEvent = { preventDefault: vi.fn() };
    webContents.emitEvent('before-input-event', keyEvent, {
      type: 'keyDown',
      key: 'Tab',
      control: true,
      shift: true,
      alt: false,
      meta: false,
    });

    expect(keyEvent.preventDefault).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(tabNavigationShortcutChannel, {
      source: { kind: 'browser', browserId: 'browser-1' },
      direction: 'previous',
    });
  });

  it('emits app shortcuts from focused browser webContents', () => {
    for (const { platform, mod } of MOD_PLATFORMS) {
      // 整个 registry 都建在桩里:快捷键表在 registerSession 那一步就解析定型,
      // 只把按键那一刻套进去太晚了。
      const keyEvent = withPlatform(platform, () => {
        const registry = new BrowserWebContentsRegistry();
        registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
        const webContents = fakeWebContents();
        adopt(registry, 'browser-1', webContents);
        const ev = { preventDefault: vi.fn() };
        webContents.emitEvent('before-input-event', ev, {
          type: 'keyDown',
          key: 'P',
          shift: false,
          alt: false,
          ...mod,
        });
        return ev;
      });

      expect(keyEvent.preventDefault, platform).toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith(browserAppShortcutChannel, {
        source: { kind: 'browser', browserId: 'browser-1' },
        commandId: 'app.commandPalette',
      });
    }
  });

  it('does not emit disabled app shortcuts from focused browser webContents', () => {
    for (const { platform, mod } of MOD_PLATFORMS) {
      const press = (setup: (r: BrowserWebContentsRegistry) => void) =>
        withPlatform(platform, () => {
          const registry = new BrowserWebContentsRegistry();
          setup(registry);
          registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });
          const webContents = fakeWebContents();
          adopt(registry, 'browser-1', webContents);
          const ev = { preventDefault: vi.fn() };
          webContents.emitEvent('before-input-event', ev, {
            type: 'keyDown',
            key: 'P',
            shift: false,
            alt: false,
            ...mod,
          });
          return ev;
        });

      // 阳性对照:同一个平台、同一组按键,在**没有**禁用时必须真的触发。
      // 没有它,下面那条 not.toHaveBeenCalled 会因为「按键根本没匹配上」而平凡为真。
      expect(press(() => {}).preventDefault, `${platform} 未禁用`).toHaveBeenCalled();
      // 对照自己也会 emit,而 events.emit 是整个文件共用的 mock —— 不清掉,
      // 下面那条 not.toHaveBeenCalledWith 会被对照留下的那一次判红。
      vi.mocked(events.emit).mockClear();

      const keyEvent = press((r) => r.setKeyboardSettings({ 'app.commandPalette': null }));
      expect(keyEvent.preventDefault, `${platform} 已禁用`).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalledWith(browserAppShortcutChannel, expect.anything());
    }
  });

  it('does not consume Escape in focused browser webContents', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    adopt(registry, 'browser-1', webContents);

    const keyEvent = { preventDefault: vi.fn() };
    webContents.emitEvent('before-input-event', keyEvent, {
      type: 'keyDown',
      key: 'Escape',
      control: false,
      shift: false,
      alt: false,
      meta: false,
    });

    expect(keyEvent.preventDefault).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalledWith(browserAppShortcutChannel, expect.anything());
  });

  it('does not consume shortcuts ignored in focused browser webContents', () => {
    const registry = new BrowserWebContentsRegistry();
    registry.registerSession({ browserId: 'browser-1', partition: PROFILE_PARTITION });

    const webContents = fakeWebContents();
    adopt(registry, 'browser-1', webContents);

    const keyEvent = { preventDefault: vi.fn() };
    webContents.emitEvent('before-input-event', keyEvent, {
      type: 'keyDown',
      key: 'Z',
      control: true,
      shift: false,
      alt: false,
      meta: false,
    });

    expect(keyEvent.preventDefault).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalledWith(browserAppShortcutChannel, expect.anything());
  });

  it('clears storage for a named profile without requiring an open browser', async () => {
    const registry = new BrowserWebContentsRegistry();

    await expect(registry.clearProfileStorage('work')).resolves.toBe(true);
    await expect(registry.clearProfileStorage('isolated-per-session')).resolves.toBe(false);

    const profileSession = sessionsByPartition.get('persist:gugu-browser-profile-work') as
      | { clearData: ReturnType<typeof vi.fn> }
      | undefined;
    expect(profileSession?.clearData).toHaveBeenCalled();
  });

  it('clears the requested browsing data category across every passed partition', async () => {
    const registry = new BrowserWebContentsRegistry();
    const partitions = [PROFILE_PARTITION, 'persist:gugu-browser-profile-work'];

    await expect(registry.clearBrowsingData('cache', partitions)).resolves.toBe(true);

    for (const partition of partitions) {
      const partitionSession = sessionsByPartition.get(partition) as
        | { clearData: ReturnType<typeof vi.fn> }
        | undefined;
      expect(partitionSession?.clearData).toHaveBeenCalledWith({ dataTypes: ['cache'] });
    }
  });

  it('passes no options for an "all" clear and dataTypes for other categories', async () => {
    const registry = new BrowserWebContentsRegistry();

    await registry.clearBrowsingData('all', [PROFILE_PARTITION]);
    await registry.clearBrowsingData('cookies', [PROFILE_PARTITION]);
    await registry.clearBrowsingData('siteData', [PROFILE_PARTITION]);

    const partitionSession = sessionsByPartition.get(PROFILE_PARTITION) as {
      clearData: ReturnType<typeof vi.fn>;
    };
    expect(partitionSession.clearData).toHaveBeenNthCalledWith(1);
    expect(partitionSession.clearData).toHaveBeenNthCalledWith(2, { dataTypes: ['cookies'] });
    expect(partitionSession.clearData).toHaveBeenNthCalledWith(3, {
      dataTypes: [
        'backgroundFetch',
        'cacheStorage',
        'fileSystems',
        'indexedDB',
        'localStorage',
        'serviceWorkers',
        'webSQL',
      ],
    });
  });
});

// #6264 别的机器上的网页:同一份预览里的另一页照走(同源 = 同一道围栏),其余照旧按 http(s) 白名单判。
describe('isSamePreviewNavigation', () => {
  it('allows moving between pages of the same preview', () => {
    expect(isSamePreviewNavigation('gugu-preview://abc/index.html', 'gugu-preview://abc/docs/b.html#x')).toBe(true);
  });

  it('refuses another preview, other schemes, and pages that are not previews', () => {
    expect(isSamePreviewNavigation('gugu-preview://abc/index.html', 'gugu-preview://zzz/b.html')).toBe(false);
    expect(isSamePreviewNavigation('gugu-preview://abc/index.html', 'file:///etc/passwd')).toBe(false);
    expect(isSamePreviewNavigation('https://example.com/', 'gugu-preview://abc/b.html')).toBe(false);
    expect(isSamePreviewNavigation('about:blank', 'gugu-preview://abc/b.html')).toBe(false);
    expect(isSamePreviewNavigation('', 'not a url')).toBe(false);
  });
});
