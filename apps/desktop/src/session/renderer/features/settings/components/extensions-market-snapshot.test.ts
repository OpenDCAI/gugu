import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../../tests/support/awaitCondition';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// owner 10-16「现在打开 app 页每次都要刷新比较长的时间，能不能变成那种要刷新后台刷新（或者第一次的时候才阻塞刷新），本地有缓存啊」.
// The App page's market: drawn at once from what this page last drew for that machine, read from the machine's index in
// hand, and the download site asked behind it (`marketRefresh`); an index that came back different is read again in place.
const h = vi.hoisted(() => {
  const item = (id: string, version = '1.0.0') => ({
    manifest: { id, name: `App ${id}`, version, apiVersion: 4, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: id }] } },
    ref: { extensionId: id, version },
    cloud: {
      version,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 10,
      apiVersion: 4,
      minAppVersion: '0.1.0',
      releaseNotes: '',
      publishedAt: '2026-10-01T00:00:00Z',
      firstPublishedAt: '2026-10-01T00:00:00Z',
      iconUrl: null,
      deprecated: null,
      compat: null,
      newerNeedsApp: null,
      source: { repo: 'r', path: 'p', commit: 'c' },
      featured: false,
      firstRun: false,
    },
  });
  const listing = (ids: string[], fetchedAt: string) => ({
    success: true,
    data: { extensions: ids.map((id) => item(id)), invalid: [], errorKind: null, error: null, total: ids.length, page: 0, hasMore: false, fetchedAt },
  });
  const answer = (data: unknown) => async () => ({ success: true, data });
  const api = {
    list: vi.fn(answer({ extensions: [], invalid: [], icons: {}, disabled: [] })),
    variants: vi.fn(answer({ active: 'upstream', variants: [], behind: null })),
    revoked: vi.fn(answer({})),
    agentStatus: vi.fn(answer({})),
    marketUpdates: vi.fn(answer({ checkedAt: '2026-10-16T00:00:00.000Z', updates: {}, yanked: {}, deprecated: {} })),
    market: vi.fn(),
    marketRefresh: vi.fn(),
    marketEntry: vi.fn(async () => ({ success: false, error: 'offline' })),
  };
  /** What main pushes on `marketRefreshedChannel` for the machine on show. */
  const heard: ((refreshed: unknown) => void)[] = [];
  const host = { key: 'local', local: true };
  return { item, listing, api, heard, host };
});

vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: async () => ({ data: [], error: null }) } }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { extensions: {}, app: {} },
  rpcOn: () => ({}),
  events: { on: () => () => undefined },
  onMachineEvent: () => () => undefined,
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }));
vi.mock('@renderer/features/extensions/register-extension-tabs', () => ({ registerInstalledExtensionTabs: vi.fn() }));
vi.mock('@renderer/features/extensions/panel/app-given-section', () => ({ AppGivenSection: () => null }));
vi.mock('@renderer/features/library/library-host', async () => {
  const { InstalledExtensionsStore } = await import('@renderer/features/extensions/installed-extensions-store');
  const stores = new Map<string, InstanceType<typeof InstalledExtensionsStore>>();
  return {
    useLibraryHost: () => {
      const store = stores.get(h.host.key) ?? new InstalledExtensionsStore(h.api as never);
      stores.set(h.host.key, store);
      const extensions = {
        key: h.host.key,
        api: h.api,
        store,
        onEvent: (_event: unknown, listener: (refreshed: unknown) => void) => {
          h.heard.push(listener);
          return () => h.heard.splice(h.heard.indexOf(listener), 1);
        },
        local: h.host.local,
        pickFolder: vi.fn(),
      };
      return { extensions, remote: h.host.local ? undefined : { deviceLabel: 'Studio', online: true, lastSeenAt: null, hostKind: 'desktop' } };
    },
  };
});

const { SessionLocalizationProvider } = await import('@renderer/localization/localization-provider');
const { toast } = await import('@renderer/lib/hooks/use-toast');
const { ExtensionsSettingsCard } = await import('./ExtensionsSettingsCard');

const T1 = '2026-10-16T01:00:00.000Z';
const T2 = '2026-10-16T01:05:00.000Z';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('the App page market: the index in hand at once, the download site behind it', () => {
  let dom: JSDOM;
  let root: Root;
  /** Every time the market panel showed its skeleton, after the first tiles were drawn. */
  let skeletonsAfterTiles: number;
  let observer: MutationObserver;

  const doc = () => dom.window.document;
  // One task boundary: the answers already settled, their renders and effects all run — what has not happened by then is not
  // on its way. ❌ a wall clock: what must happen is waited for with `until`.
  const turn = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
  const tiles = () => [...doc().querySelectorAll('[data-testid="extensions-market-panel"] [data-testid^="extension-card-"]')];
  const tileIds = () => tiles().map((node) => node.getAttribute('data-testid')!.replace('extension-card-', ''));
  const skeleton = () => doc().querySelector('[data-testid="extensions-market-panel"] [role="status"][aria-busy="true"]');
  const stale = () => doc().querySelector('[data-testid="extension-market-stale"]');

  async function open() {
    await act(async () => {
      root.render(React.createElement(SessionLocalizationProvider, null, React.createElement(ExtensionsSettingsCard)));
    });
  }
  async function close() {
    await act(async () => root.render(null));
  }
  async function push(refreshed: unknown) {
    await act(async () => {
      for (const listener of [...h.heard]) listener(refreshed);
    });
  }

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);
    h.host.key = `local-${Math.random()}`;
    h.host.local = true;
    h.heard.length = 0;
    h.api.market.mockReset().mockResolvedValue(h.listing(['one', 'two'], T1));
    h.api.marketRefresh.mockReset().mockResolvedValue({ success: true, data: { outcome: 'unchanged', fetchedAt: T1 } });
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    skeletonsAfterTiles = 0;
    let drawn = false;
    observer = new dom.window.MutationObserver(() => {
      if (tiles().length > 0) drawn = true;
      if (drawn && skeleton()) skeletonsAfterTiles += 1;
    });
    observer.observe(dom.window.document.body, { subtree: true, childList: true, attributes: true });
  });

  afterEach(() => {
    observer.disconnect();
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  it('opened again, this machine draws what it drew last at once — before the market answers, ❌ a skeleton', async () => {
    await open();
    await until('the first read drawn', tileIds, (ids) => ids.length > 0);
    await turn();
    expect(tileIds()).toEqual(['one', 'two']);
    await close();
    h.api.market.mockReturnValue(new Promise(() => undefined));
    await open();
    expect(tileIds()).toEqual(['one', 'two']);
    expect(skeleton()).toBeNull();
    // Control: another machine has drawn nothing here yet — it waits for its answer.
    await close();
    h.host.key = 'remote:never-shown';
    await open();
    expect(tiles()).toHaveLength(0);
    expect(skeleton()).not.toBeNull();
  });

  it('opening asks the download site once; nothing changed → the market is not read again', async () => {
    await open();
    await until('the first read drawn', tileIds, (ids) => ids.length > 0);
    await until('the download site asked', () => h.api.marketRefresh.mock.calls.length, (n) => n >= 1);
    // Its answer (unchanged) is in by the next task: asked once, nothing more is read.
    await turn();
    expect(h.api.marketRefresh).toHaveBeenCalledTimes(1);
    expect(h.api.market).toHaveBeenCalledTimes(1);
    expect(stale()).toBeNull();
  });

  it('the index came back changed → the tiles are read again in place: ❌ skeleton, the unchanged tile is the same element', async () => {
    const refreshed = deferred<unknown>();
    h.api.marketRefresh.mockReturnValue(refreshed.promise);
    await open();
    await until('the first read drawn', tileIds, (ids) => ids.length > 0);
    await turn();
    expect(tileIds()).toEqual(['one', 'two']);
    const before = tiles()[0];
    // The read again is on its way (its answer held): what is drawn stays, ❌ a skeleton in between.
    const reread = deferred<unknown>();
    h.api.market.mockReturnValue(reread.promise);
    await act(async () => refreshed.resolve({ success: true, data: { outcome: 'changed', fetchedAt: T2 } }));
    await until('read again', () => h.api.market.mock.calls.length, (n) => n >= 2);
    await turn();
    expect(h.api.market).toHaveBeenCalledTimes(2);
    expect(skeleton()).toBeNull();
    expect(tileIds()).toEqual(['one', 'two']);
    await act(async () => reread.resolve(h.listing(['one', 'two', 'three'], T2)));
    await until('the new read drawn', tileIds, (ids) => ids.join() !== 'one,two');
    await turn();
    expect(tileIds()).toEqual(['one', 'three', 'two']);
    expect(tiles()[0]).toBe(before);
    expect(skeletonsAfterTiles).toBe(0);
    expect(h.api.market).toHaveBeenCalledTimes(2);
  });

  it('a change pushed by main (an install took the index now) is read again too; the push and the answer of one moment, once', async () => {
    h.api.marketRefresh.mockResolvedValue({ success: true, data: { outcome: 'changed', fetchedAt: T2 } });
    // Main answers from the index in hand: the one of T1 when the page opens, the one of T2 once that came.
    h.api.market.mockResolvedValueOnce(h.listing(['one', 'two'], T1)).mockResolvedValue(h.listing(['one'], T2));
    await open();
    await until('read again after the answer (T2)', () => h.api.market.mock.calls.length, (n) => n >= 2);
    await turn();
    expect(h.api.market).toHaveBeenCalledTimes(2);
    expect(tileIds()).toEqual(['one']);
    // The push of the same moment: by the next task nothing more is read.
    await push({ outcome: 'changed', fetchedAt: T2 });
    await turn();
    expect(h.api.market).toHaveBeenCalledTimes(2);
    h.api.market.mockResolvedValue(h.listing(['one', 'four'], '2026-10-16T01:09:00.000Z'));
    await push({ outcome: 'changed', fetchedAt: '2026-10-16T01:09:00.000Z' });
    await until('the push of a later moment read', () => h.api.market.mock.calls.length, (n) => n >= 3);
    await turn();
    expect(h.api.market).toHaveBeenCalledTimes(3);
    expect(tileIds()).toEqual(['four', 'one']);
  });

  it('the download site not reached → the index in hand stays, one quiet line 「上次更新于 …」; ❌ an alert, ❌ a toast', async () => {
    h.api.marketRefresh.mockResolvedValue({ success: true, data: { outcome: 'failed', fetchedAt: T1 } });
    await open();
    await until('the quiet line', () => stale()?.textContent ?? null, (text) => text !== null);
    expect(tileIds()).toEqual(['one', 'two']);
    expect(stale()?.textContent).toMatch(/Last updated|上次更新于/);
    expect(doc().querySelector('[role="alert"]')).toBeNull();
    expect(doc().querySelector('[data-testid="extension-market-offline"]')).toBeNull();
    expect(toast).not.toHaveBeenCalled();
    // Reached next time: the line goes.
    await push({ outcome: 'unchanged', fetchedAt: T2 });
    await turn();
    expect(stale()).toBeNull();
  });

  it('another machine: when its index changed, its 「有新版 / 被撤回」 is read again with the tiles (its pushes may not reach here)', async () => {
    h.host.local = false;
    h.api.marketRefresh.mockResolvedValue({ success: true, data: { outcome: 'changed', fetchedAt: T2 } });
    await open();
    await until('the tiles read again', () => h.api.market.mock.calls.length, (n) => n >= 2);
    await until('its update check read again', () => h.api.marketUpdates.mock.calls.length, (n) => n >= 2);
    await turn();
    expect(h.api.market).toHaveBeenCalledTimes(2);
    expect(h.api.marketUpdates).toHaveBeenCalledTimes(2);
  });

  it('control — this machine: its 「有新版」 follows the pushes from main (wireMarketRefresh), not a second read from the page', async () => {
    h.api.marketRefresh.mockResolvedValue({ success: true, data: { outcome: 'changed', fetchedAt: T2 } });
    await open();
    await until('the tiles read again', () => h.api.market.mock.calls.length, (n) => n >= 2);
    // The answer and the read again are in by the next task: read twice, and the page asked no second update check.
    await turn();
    expect(h.api.market).toHaveBeenCalledTimes(2);
    expect(h.api.marketUpdates).toHaveBeenCalledTimes(1);
  });
});
