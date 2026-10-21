import { beforeEach, describe, expect, it, vi } from 'vitest';

// #7050 左栏「退出」:后台与启用同生死的唯一例外 —— 退出了就停着,对账也不拉起,直到它再被打开。

const windows: { destroyed: boolean }[] = [];
vi.mock('electron', () => ({
  BrowserWindow: class {
    destroyed = false;
    webContents = { id: windows.length + 1, setWindowOpenHandler: () => undefined, on: () => undefined };
    constructor() {
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
    loadURL() {
      return Promise.resolve();
    }
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./extension-session', () => ({ configureExtensionSession: () => undefined }));
vi.mock('./bridge-preload-path', () => ({ resolveExtensionBridgePreload: () => '/preload.js' }));
const enabled = new Set<string>();
vi.mock('./extensions-root', () => ({
  extensionsService: () => ({
    list: () => ({
      extensions: ['timer', 'plain'].map((id) => ({
        rootDir: `/apps/${id}`,
        manifest: { id, ...(id === 'timer' ? { background: { entry: 'bg.html' } } : {}) },
      })),
    }),
    isEnabled: (id: string) => enabled.has(id),
    grantedHosts: () => [],
  }),
}));

const { extensionBackgroundWebContentsId, extensionOpened, forgetQuit, quitExtension, quitExtensions, syncExtensionBackgrounds } =
  await import('./extension-background');

const running = () => extensionBackgroundWebContentsId('timer') !== null;

beforeEach(() => {
  enabled.clear();
  syncExtensionBackgrounds();
  forgetQuit('timer');
  enabled.add('timer');
  enabled.add('plain');
});

describe('退出一个 App 的后台 (#7050)', () => {
  it('退出就停,对账不拉起;再打开就作废并拉起', () => {
    syncExtensionBackgrounds();
    expect(running()).toBe(true);

    quitExtension('timer');
    expect(running()).toBe(false);
    expect(quitExtensions()).toEqual(['timer']);
    // Another App switched on or off reconciles every background: the quit one stays down.
    syncExtensionBackgrounds();
    expect(running()).toBe(false);

    expect(extensionOpened('timer')).toBe(true);
    expect(running()).toBe(true);
    expect(quitExtensions()).toEqual([]);
    // Opened while not quit: nothing to undo.
    expect(extensionOpened('timer')).toBe(false);
  });

  it('停用 / 卸载让退出作废:再启用就照常在跑', () => {
    quitExtension('timer');
    enabled.delete('timer');
    expect(forgetQuit('timer')).toBe(true);
    syncExtensionBackgrounds();
    expect(running()).toBe(false);
    enabled.add('timer');
    syncExtensionBackgrounds();
    expect(running()).toBe(true);
  });

  it('没声明后台的 App 退出了也只是记一笔,没什么可停', () => {
    quitExtension('plain');
    expect(quitExtensions()).toContain('plain');
    expect(extensionOpened('plain')).toBe(true);
    expect(quitExtensions()).not.toContain('plain');
  });
});
