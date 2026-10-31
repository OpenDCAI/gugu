import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  extensions: {
    quit: vi.fn(async ({ extensionId }: { extensionId: string }) => ({ success: true, data: { quit: [extensionId] } })),
  },
}));
const reveal = vi.hoisted(() => vi.fn());
vi.mock('@renderer/features/sessions/stores/open-file-in-file-editor', () => ({
  openHostRequestedExtensionInSessionWhenReady: reveal,
}));
vi.mock('@renderer/lib/ipc', () => ({ rpc, events: { on: () => () => undefined } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const { appIsRunning, openApp, quitApp } = await import('./app-dock');
const { appPlacementStore } = await import('./app-placement-store');
const { appState } = await import('@renderer/lib/stores/app-state');
const { extensionViewStore } = await import('./extension-view-store');
const { installedExtensionsStore } = await import('./installed-extensions-store');
const { screenLayout } = await import('@renderer/app/screen-layout');

const app = (id: string, more: Record<string, unknown> = {}, tab: Record<string, unknown> = {}) => ({
  id,
  name: id,
  version: '1.0.0',
  apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
  entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: id, ...tab }] },
  ...more,
});

function install(extensions: unknown[], disabled: string[] = []): void {
  installedExtensionsStore.applyList({ extensions, invalid: [], icons: {}, disabled, disclosure: {} } as never);
}

// The rail's dock only needs a box for the page to be placed over; nothing here lays one out.
const slot = (tabId: string) => ({ tabId, element: {} as HTMLElement });

describe('左栏「开着」的小点 (#7050)', () => {
  it('声明了后台的 App,启用着就在跑;停用就不跑', () => {
    install([app('timer', { background: { entry: 'bg.html' } })]);
    expect(appIsRunning('timer')).toBe(true);
    install([app('timer', { background: { entry: 'bg.html' } })], ['timer']);
    expect(appIsRunning('timer')).toBe(false);
  });

  it('没有后台的 App:有页活着才算开着 —— 看过之后藏起来的页也算,页销毁了就不算', () => {
    install([app('notes')]);
    expect(appIsRunning('notes')).toBe(false);

    const token = extensionViewStore.claim('notes.main', slot('dock'));
    expect(appIsRunning('notes')).toBe(true);
    extensionViewStore.setSurface(token, 7);
    extensionViewStore.release('notes.main', token);
    expect(appIsRunning('notes')).toBe(true);

    extensionViewStore.forgetOpened('notes.main');
    expect(appIsRunning('notes')).toBe(false);
  });

  it('一次都没画出来就被放下的页不留,也就不算开着', () => {
    install([app('draft')]);
    const token = extensionViewStore.claim('draft.main', slot('dock'));
    extensionViewStore.release('draft.main', token);
    expect(appIsRunning('draft')).toBe(false);
  });

  it('为一个文件开的页也算开着,关掉就不算', () => {
    install([app('board', {}, { opensFiles: { chat: ['.board.json'] } })]);
    const token = extensionViewStore.claim('board.main', { ...slot('file'), chatId: 'c1', itemId: 'i1' });
    expect(appIsRunning('board')).toBe(true);
    extensionViewStore.release('board.main', token);
    expect(appIsRunning('board')).toBe(false);
  });

  it('别的 App 的页不算它的', () => {
    install([app('a'), app('b')]);
    const token = extensionViewStore.claim('a.main', slot('dock'));
    expect(appIsRunning('b')).toBe(false);
    extensionViewStore.release('a.main', token);
  });
});

describe('左栏「退出」(#7050)', () => {
  // The renderer waits a frame for the places it closed to unmount; node has no frames.
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));

  it.each(['chat', 'project'] as const)('quitting a whole-page App returns to the shared %s block', async (kind) => {
    install([app('timer')]);
    const content = kind === 'chat' ? { kind, chatId: 'c1' } : { kind, projectId: 'p1' };
    screenLayout.show(content);
    const saved = screenLayout.snapshot;
    appState.navigation.navigate('app', { appId: 'timer' });
    await quitApp('timer');
    expect(appState.navigation.currentViewId).toBe(kind);
    expect(screenLayout.snapshot).toEqual(saved);
    screenLayout.forgetContent(content);
  });

  it('退出了的 App,后台不算在跑;它的页再被要(主进程说它不再是退出的)就又算', () => {
    install([app('timer', { background: { entry: 'bg.html' } })]);
    installedExtensionsStore.applyQuit(['timer']);
    expect(appIsRunning('timer')).toBe(false);
    installedExtensionsStore.applyQuit([]);
    expect(appIsRunning('timer')).toBe(true);
  });

  it('收掉它在会话里那一格、离开它的整页、告诉主进程,再销毁藏着活的页;还在屏上的页留着', async () => {
    install([app('timer', { background: { entry: 'bg.html' } })]);
    appPlacementStore.place('timer.main', { projectId: 'p', sessionId: 's1' });
    appState.navigation.navigate('app', { appId: 'timer' });
    // One page kept hidden (looked at, then left), one on screen (claimed now).
    const hidden = extensionViewStore.claim('timer.main', { ...slot('a'), sessionId: 's1' });
    extensionViewStore.setSurface(hidden, 1);
    extensionViewStore.release('timer.main', hidden);
    const onScreen = extensionViewStore.claim('timer.main', { ...slot('b'), chatId: 'c1' });

    await quitApp('timer');

    // Its place in a session is taken away (#7052): that session drops its tab on its own (app-placement-sync).
    expect(appPlacementStore.of('timer.main')).toBeUndefined();
    expect(appState.navigation.currentViewId).not.toBe('app');
    expect(rpc.extensions.quit).toHaveBeenCalledWith({ extensionId: 'timer' });
    expect(installedExtensionsStore.quit).toEqual(['timer']);
    expect([...extensionViewStore.residentPages.values()].map((page) => page.place)).toEqual(['chat:c1']);
    // Still drawn somewhere, so still open: the dot stays until that place goes too.
    expect(appIsRunning('timer')).toBe(true);
    extensionViewStore.release('timer.main', onScreen);
    extensionViewStore.forgetOpened('timer.main');
    expect(appIsRunning('timer')).toBe(false);
  });

  it('主进程不肯退出就告诉调用方(左栏据此提示「没能退出」)', async () => {
    install([app('timer')]);
    rpc.extensions.quit.mockResolvedValueOnce({ success: false, error: 'nope' } as never);
    await expect(quitApp('timer')).rejects.toThrow('nope');
  });
});

describe('右键「App」列出来的 App (#7050)', () => {
  it('装着、启用、有自己一页的都列,按装的先后;停用的、只开文件的不列', () => {
    install(
      [app('zeta'), app('off'), app('files', {}, { opensFiles: { chat: ['.x.json'] } }), app('alpha')],
      ['off']
    );
    expect(installedExtensionsStore.openableApps.map((entry) => entry.extensionId)).toEqual(['zeta', 'alpha']);
  });
});

// #7052 behavior tab-extensions「点左栏它的图标 = 去它现在在的地方;哪都没摆着才整页打开」。
describe('点左栏一个 App', () => {
  it('an App block needs no old session to bring its workspace forward', () => {
    install([app('clock')]);
    screenLayout.show({ kind: 'app', tabKind: 'clock.main' });
    const saved = screenLayout.snapshot;
    appState.navigation.navigate('assistant');
    openApp('clock');
    expect(appState.navigation.currentViewId).toBe('screen');
    expect(screenLayout.snapshot).toEqual(saved);
    screenLayout.forgetApp('clock.main');
  });

  it('哪都没摆着:整页打开', () => {
    install([app('clock')]);
    appPlacementStore.take('clock.main');
    appState.navigation.navigate('home');
    openApp('clock');
    expect(appState.navigation.currentViewId).toBe('app');
    expect(appState.navigation.viewParamsStore.app?.appId).toBe('clock');
  });

  it('摆在某条会话里:去那条会话,把它那一枚翻到前面', async () => {
    install([app('clock')]);
    appPlacementStore.place('clock.main', { projectId: 'p1', sessionId: 's9' });
    appState.navigation.navigate('home');
    openApp('clock');
    expect(appState.navigation.currentViewId).toBe('session');
    expect(appState.navigation.viewParamsStore.session).toMatchObject({ projectId: 'p1', sessionId: 's9' });
    await vi.waitFor(() =>
      expect(reveal).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', sessionId: 's9', tabKind: 'clock.main', reveal: true }))
    );
    appPlacementStore.take('clock.main');
  });
});
