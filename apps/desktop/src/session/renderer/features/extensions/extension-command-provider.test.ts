import { autorun, runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';

const invokeCommand = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: { invokeCommand } }, events: { on: () => () => {} } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const { createExtensionCommandProvider } = await import('./extension-command-provider');
const { installedExtensionsStore: store } = await import('./installed-extensions-store');
const { extensionViewStore: views } = await import('./extension-view-store');
const { extensionSurfaceStore: surfaces } = await import('./extension-surface-store');
const { auxWindows } = await import('@renderer/app/aux-windows');
const { appState } = await import('@renderer/lib/stores/app-state');
const provider = createExtensionCommandProvider();
const command = { id: 'new', title: 'New card' };
const app = (id = 'board') => ({ id, name: 'Board', version: '1.0.0', apiVersion: EXTENSION_API_VERSION,
  localized: { zh: { name: '看板' } }, entry: 'index.html', contributes: { tabs: [
    { name: 'main', title: 'Board', menu: [command], toolbar: [command, { id: 'refresh', title: 'Refresh' }] },
    { name: 'file', title: 'File', opensFiles: { chat: ['.board.json'] }, menu: [command] },
  ] } });
function install(apps: unknown[] = [app()], disabled: string[] = []) {
  store.applyList({ extensions: apps, invalid: [], icons: {}, disabled, disclosure: {} } as never);
  runInAction(() => { store.locale = 'en'; });
}
afterEach(() => {
  invokeCommand.mockClear();
  views.forgetOpened('board.main');
  surfaces.forget(null, 'command-test');
  vi.unstubAllGlobals();
});

describe('enabled App commands in the global registry', () => {
  it('prefixes localized App names, combines menu/toolbar ids and does not open blank file pages', () => {
    install([app(), app('disabled')], ['disabled']);
    expect(provider.getCommands().map(({ id, label }) => [id, label])).toEqual([
      ['extension:board.main:new', 'Board: New card'], ['extension:board.main:refresh', 'Board: Refresh'],
    ]);
    runInAction(() => { store.locale = 'zh'; });
    expect(provider.getCommands()[0]?.label).toBe('看板: New card');
  });

  it('reacts to disable, enable, manifest replacement and uninstall without retaining old commands', () => {
    install();
    const seen: string[][] = [];
    const dispose = autorun(() => { seen.push(provider.getCommands().map((entry) => entry.label!)); });
    try {
      store.applyDisabled(['board']);
      expect(seen.at(-1)).toEqual([]);
      store.applyDisabled([]);
      expect(seen.at(-1)).toEqual(['Board: New card', 'Board: Refresh']);
      const updated = app(); updated.contributes.tabs[0]!.menu = [{ id: 'export', title: 'Export' }];
      updated.contributes.tabs[0]!.toolbar = [];
      install([updated]);
      expect(seen.at(-1)).toEqual(['Board: Export']);
      install([]);
      expect(seen.at(-1)).toEqual([]);
    } finally { dispose(); }
  });

  it('opens the App through the dock and waits for its actual binding before invoking exactly once', async () => {
    install();
    vi.stubGlobal('window', new EventTarget());
    provider.getCommands()[0]!.execute();
    expect(appState.navigation.currentViewId).toBe('app');
    expect(appState.navigation.viewParamsStore.app).toEqual({ appId: 'board', tab: 'main' });
    expect(invokeCommand).not.toHaveBeenCalled();
    views.claim('board.main', { tabId: 'command-test', element: {} as HTMLElement });
    expect(invokeCommand).not.toHaveBeenCalled();
    surfaces.setWebContentsId(null, 'command-test', 42);
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledExactlyOnceWith({ webContentsId: 42, commandId: 'new' }));
  });

  it('focuses a detached App and uses the same window surface as its existing toolbar', async () => {
    install();
    vi.stubGlobal('window', new EventTarget());
    const id = auxWindows.add({ kind: 'app', tabKind: 'board.main' });
    const focus = vi.fn();
    auxWindows.setHandle(id, { focus } as unknown as Window);
    surfaces.setWebContentsId(null, `window:${id}`, 84);
    try {
      provider.getCommands()[0]!.execute();
      expect(focus).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledExactlyOnceWith({ webContentsId: 84, commandId: 'new' }));
    } finally { auxWindows.remove(id); surfaces.forget(null, `window:${id}`); }
  });
});
