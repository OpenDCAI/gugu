import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: {} } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const { InstalledExtensionsStore } = await import('./installed-extensions-store');

type Api = ConstructorParameters<typeof InstalledExtensionsStore>[0];

function storeWith(setDisclosure: (args: { extensionId: string; level: 'full' | 'progressive' }) => Promise<unknown>) {
  const api = {
    list: async () => ({
      success: true,
      data: { extensions: [], invalid: [], icons: {}, disabled: [], disclosure: { tools: 'progressive' } },
    }),
    marketUpdates: async () => ({ success: true, data: null }),
    setDisclosure,
  } as unknown as Api;
  return new InstalledExtensionsStore(api);
}

describe('披露档位的写入 (W-08)', () => {
  it('先按用户拨的画,落定后以主进程的回答为准', async () => {
    let settle!: (value: unknown) => void;
    const store = storeWith(() => new Promise((resolve) => { settle = resolve; }));
    await store.load();
    const writing = store.setDisclosure('tools', 'full');
    expect(store.disclosure.tools).toBe('full');
    settle({ success: true, data: { level: 'full' } });
    await writing;
    expect(store.disclosure.tools).toBe('full');
  });

  it('写不进去就退回原档,并把失败交给调用方', async () => {
    const store = storeWith(async () => ({ success: false, error: 'not installed' }));
    await store.load();
    await expect(store.setDisclosure('tools', 'full')).rejects.toThrow('not installed');
    expect(store.disclosure.tools).toBe('progressive');
  });

  it('不给 agent 工具的扩展没有档位可写', async () => {
    const store = storeWith(vi.fn());
    await store.load();
    await expect(store.setDisclosure('plain', 'full')).rejects.toThrow('gives agents no tools');
  });
});

describe('which Apps are a task session tab (L6-8, 摩擦单 F3 / F95 / F98)', () => {
  const app = (id: string, opensFiles?: unknown) => ({
    id,
    name: id,
    version: '1.0.0',
    apiVersion: EXTENSION_API_VERSION,
    entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: id, ...(opensFiles === undefined ? {} : { opensFiles }) }] },
  });
  const storeListing = (extensions: unknown[], more: Record<string, unknown> = {}) =>
    new InstalledExtensionsStore({
      list: async () => ({ success: true, data: { extensions, invalid: [], icons: {}, disabled: [], disclosure: {}, ...more } }),
      marketUpdates: async () => ({ success: true, data: null }),
      setDisclosure: vi.fn(),
    } as unknown as Api);

  it('names the default page in the interface language and preserves a specifically named subpage', async () => {
    const calendar = { ...app('calendar'), name: '日历', localized: { en: { name: 'Calendar' } }, contributes: { tabs: [
      { name: 'main', title: '日历' }, { name: 'reports', title: 'Reports' },
    ] } };
    const store = storeListing([calendar]);
    await store.load();
    store.locale = 'en-US';
    expect(store.tabTitle('calendar.main')).toBe('Calendar');
    expect(store.tabTitle('calendar.reports')).toBe('Reports');
    expect(store.tabTitle('missing.main')).toBeUndefined();
  });

  // F95 (S23): a「TODO 看板」tab bound to no file — "Open a .todo-kanban.json file" and an uncaught error. A tab that
  // opens files, in a session or a group, is opened for a file; with none it has nothing to show.
  it('a tab that opens files is no session tab of its own — it still has its page where a file opens it', async () => {
    const store = storeListing([app('vote', { chat: ['.vote.json'] }), app('grid', { session: ['.csv'] }), app('plain'), app('board', { session: ['TODO.md'] })]);
    await store.load();
    expect(store.enabledTabContributions.map((entry) => entry.extensionId)).toEqual(['plain']);
    expect(store.residentTabContributions.map((entry) => entry.extensionId)).toEqual(['vote', 'grid', 'plain', 'board']);
  });

  // owner 10-28: Browser Use's per-task browser is the host's page (`hostPage: 'browser'`); its tab is named for the App,
  // as the settings page is.
  it('a host browser page is the host’s, one per task, and named for the App', async () => {
    const browserUse = {
      id: 'browser-use', name: 'Browser Use', version: '1.0.0', apiVersion: EXTENSION_API_VERSION,
      contributes: {
        tabs: [{ name: 'settings', title: 'Settings', hostPage: 'settings' }, { name: 'browser', title: 'Browser', hostPage: 'browser', perSession: true }],
        mcpServers: [{ name: 'browser-use', host: 'browser-use' }],
      },
    };
    const store = storeListing([browserUse]);
    await store.load();
    const browser = store.allTabContributions.find((entry) => entry.kind === 'browser-use.browser');
    expect(browser).toMatchObject({ title: 'Browser Use', hostBrowser: true, hostSettings: false, perSession: true });
    expect(store.tabTitle('browser-use.browser')).toBe('Browser Use');
    expect(store.allTabContributions.find((entry) => entry.kind === 'browser-use.settings')).toMatchObject({ hostSettings: true, hostBrowser: false });
    // One per task: never the App's page of its own.
    expect(store.mainTabOf('browser-use')?.kind).toBe('browser-use.settings');
  });

  // owner 10-20「没有 enable 的 app,在任务页的新建 tab 里面就不要显示了吧,灰掉也占位置」: the「+」menu, an empty pane
  // and the draft panel all list this, so a switched-off App is left out of it — and back the moment it is on.
  it('a switched-off App is no session tab until it is switched back on', async () => {
    const store = storeListing([app('plain'), app('off')], { disabled: ['off'] });
    await store.load();
    expect(store.enabledTabContributions.map((entry) => entry.extensionId)).toEqual(['plain']);
    store.applyDisabled([]);
    expect(store.enabledTabContributions.map((entry) => entry.extensionId)).toEqual(['plain', 'off']);
  });

  // The far-left rail's dock (统筹 10-01): what is pinned, in the person's order — when it is here, on, and has a page.
  it('the rail shows the pinned Apps that can open from it, in the dock’s order, with their own icon', async () => {
    const store = storeListing([app('plain'), app('clock'), app('vote', { chat: ['.vote.json'] }), app('off')], {
      dock: ['clock', 'gone', 'vote', 'off', 'plain'],
      disabled: ['off'],
      appIcons: { clock: 'data:image/png;base64,AAAA' },
    });
    await store.load();
    expect(store.dockedApps).toEqual([
      { extensionId: 'clock', name: 'clock', kind: 'clock.main', iconDataUrl: 'data:image/png;base64,AAAA' },
      { extensionId: 'plain', name: 'plain', kind: 'plain.main', iconDataUrl: null },
    ]);
    // Switched back on, it is back in its place: the dock keeps it while it is off.
    store.applyDisabled([]);
    expect(store.dockedApps.map((entry) => entry.extensionId)).toEqual(['clock', 'off', 'plain']);
  });
});

// owner 10-20「我没懂为什么我的 app 页有红点」: three switched-off Apps with a newer version lit it, though they sit in
// 「已停用」 and nothing said which. VS Code's badge counts only enabled outdated extensions (extensionsViewlet.ts L1052).
describe('the 「App」 badge (updateCount)', () => {
  const summary = {
    checkedAt: '2026-10-20T00:00:00.000Z',
    updates: { off: { version: '2.0.0', releaseNotes: '' }, on: { version: '2.0.0', releaseNotes: '' } },
    yanked: { 'off-yanked': { reason: 'broken', installable: null } },
    deprecated: {},
    gone: [],
  };
  const storeWithUpdates = (disabled: string[]) =>
    new InstalledExtensionsStore({
      list: async () => ({ success: true, data: { extensions: [], invalid: [], icons: {}, disabled, disclosure: {} } }),
      marketUpdates: async () => ({ success: true, data: summary }),
      setDisclosure: vi.fn(),
    } as unknown as Api);

  it('counts a newer version only of an App that is on; a yanked one is counted on or off', async () => {
    const store = storeWithUpdates(['off', 'off-yanked']);
    await store.load();
    await store.checkUpdates();
    expect(store.updateCount).toBe(2);
    store.applyDisabled(['on', 'off', 'off-yanked']);
    expect(store.updateCount).toBe(1);
    store.applyDisabled([]);
    expect(store.updateCount).toBe(3);
  });
});
