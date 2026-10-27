import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../../tests/support/awaitCondition';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Settings → Extensions → Install from folder, with `notes` 1.0.0 installed from a folder (it reads the working
// copy, and the person took that back). Main says what the next version would ask (`consent: return`, install-prepared.ts:
// whether it asks at all is main's `installPlan`); the card asks when it does, and installs the bytes agreed to.
const h = vi.hoisted(() => {
  const manifest = (version: string, network: string[] = [], capabilities = ['files:read']) => ({
    id: 'notes',
    name: 'Notes',
    version,
    apiVersion: 3, // inside vi.hoisted: runs before any import
    entry: 'index.html',
    permissions: { capabilities, network },
    contributes: { tabs: [{ name: 'main', title: 'Notes' }] },
  });
  const answer = (data: unknown) => async () => ({ success: true, data });
  const offline = async () => ({ success: false, error: 'offline' });
  const api = {
    list: vi.fn(answer({ extensions: [manifest('1.0.0')], invalid: [], icons: {}, disabled: [] })),
    switchVariant: vi.fn(),
    marketReadme: vi.fn(answer({ readme: null })),
    marketHistory: vi.fn(answer([])),
    revoked: vi.fn(answer({ notes: ['files:read'] })),
    agentStatus: vi.fn(answer({})),
    marketUpdates: vi.fn(answer({ checkedAt: '2026-09-28T00:00:00.000Z', updates: {}, yanked: {}, deprecated: {} })),
    market: vi.fn(offline),
    marketRefresh: vi.fn(answer({ outcome: 'unchanged', fetchedAt: '2026-09-28T00:00:00.000Z' })),
    marketEntry: vi.fn(offline),
    installFromFolder: vi.fn(),
    uninstall: vi.fn(async () => ({ success: true })),
  };
  return { manifest, api, ranking: vi.fn(async () => ({ data: [], error: null })), showConfirm: vi.fn(), pickFolder: vi.fn(async () => '/tmp/notes-next') };
});

vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: h.ranking } }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { extensions: {} },
  rpcOn: () => ({}),
  events: { on: () => () => undefined },
  onMachineEvent: () => () => undefined,
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => h.showConfirm }));
vi.mock('@renderer/features/extensions/register-extension-tabs', () => ({ registerInstalledExtensionTabs: vi.fn() }));
// A row's 「给哪些 agent」 is the main renderer's editor, which reads the platform as it loads: not what these cells are about.
vi.mock('@renderer/features/extensions/panel/app-given-section', () => ({ AppGivenSection: () => null }));
vi.mock('@renderer/features/library/library-host', async () => {
  const { InstalledExtensionsStore } = await import('@renderer/features/extensions/installed-extensions-store');
  const extensions = {
    key: 'local',
    api: h.api,
    store: new InstalledExtensionsStore(h.api as never),
    onEvent: () => () => undefined,
    local: true,
    pickFolder: h.pickFolder,
  };
  return { useLibraryHost: () => ({ extensions, remote: undefined }) };
});

const { SessionLocalizationProvider } = await import('@renderer/localization/localization-provider');
const { translateSessionMessage } = await import('@renderer/localization/locale-store');
const { toast } = await import('@renderer/lib/hooks/use-toast');
const { ExtensionsSettingsCard } = await import('./ExtensionsSettingsCard');

// How this build refuses an App written for apiVersion 2, as list() hands it over (#6934).
const REFUSED = 'Invalid manifest:\n- apiVersion: apiVersion 2 is an older App interface; ask an agent to rewrite the App for apiVersion 4 as app_create writes Apps.';

/** The page opens on the market (#7059); these rows live on 已安装. */
async function showInstalled(dom: JSDOM) {
  const tab = dom.window.document.querySelector('[data-testid="extensions-tab-installed"]') as HTMLButtonElement;
  await act(async () => void tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
}

describe('Install from folder over a folder install (quiet upgrade)', () => {
  let dom: JSDOM;
  let root: Root;

  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));

  /** What main hands back for the folder (`return`): the sheet, read against the 1.0.0 installed here, and whether it asks. */
  async function installFromFolder(next: unknown, asks: boolean) {
    h.api.installFromFolder.mockImplementation(async ({ consent }: { consent: { kind: string } }) =>
      consent.kind === 'return'
        ? { success: true, data: { outcome: 'ask', ask: { manifest: next, manifestDigest: 'digest-next', installed: h.manifest('1.0.0'), revokedPermissions: ['files:read'] }, asks } }
        : { success: true, data: { outcome: 'confirmed', manifest: next } })
    await act(async () => {
      root.render(React.createElement(SessionLocalizationProvider, null, React.createElement(ExtensionsSettingsCard)));
    });
    await settle();
    const button = [...dom.window.document.querySelectorAll('button')].find((node) =>
      /Install from folder|装本地文件夹/.test(node.textContent ?? '')
    );
    expect(button, 'the Install from folder button').toBeDefined();
    await act(async () => void button!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    await settle();
    expect(h.api.installFromFolder).toHaveBeenCalledWith({ sourceDir: '/tmp/notes-next', consent: { kind: 'return' } });
  }
  const given = { sourceDir: '/tmp/notes-next', consent: { kind: 'given', digest: 'digest-next' } };

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  it('replaces it without a dialog when the version asks for nothing new', async () => {
    await installFromFolder(h.manifest('2.0.0'), false);
    expect(h.showConfirm).not.toHaveBeenCalled();
    expect(h.api.installFromFolder).toHaveBeenLastCalledWith(given);
  });

  it('asks when the version newly asks for a host, and lists only that host', async () => {
    await installFromFolder(h.manifest('2.0.0', ['api.example.com']), true);
    expect(h.api.installFromFolder).not.toHaveBeenCalledWith(given);
    expect(h.showConfirm).toHaveBeenCalledOnce();
    const { description } = h.showConfirm.mock.calls[0][0] as { description: string };
    expect(description).toContain('api.example.com');
    // The working copy was taken back: it stays taken back, and the dialog does not ask about it again.
    expect(description).not.toMatch(/working copy|工作副本/);
  });

  it('a newly asked ability is said as its own sentence, not as a place to reach', async () => {
    await installFromFolder(h.manifest('2.0.0', [], ['files:read', 'notifications']), true);
    const { description } = h.showConfirm.mock.calls[0][0] as { description: string };
    expect(description).toMatch(/Show system notifications|发系统通知/);
    expect(description).not.toMatch(/reach|访问/);
  });

  it('asks when main says it asks (E-05: replacing one installed from the market), and installs the bytes agreed to', async () => {
    await installFromFolder(h.manifest('2.0.0'), true);
    expect(h.api.installFromFolder).not.toHaveBeenCalledWith(given);
    expect(h.showConfirm).toHaveBeenCalledOnce();
    await act(async () => void (h.showConfirm.mock.calls[0][0] as { onSuccess: () => void }).onSuccess());
    await settle();
    expect(h.api.installFromFolder).toHaveBeenLastCalledWith(given);
  });

  // owner 10-10: the workspace App is the chat's 群文件夹, not an App one installs or removes — still preinstalled in code,
  // no longer a row of the App list. Every other App stays (the workspace is the one preinstalled App now). Control (the parent
  // commit): a 群文件夹/工作区 row.
  it('the installed list leaves out the preinstalled workspace App and keeps the others', async () => {
    const listed = h.api.list.getMockImplementation();
    const shipped = (id: string, name: string) => ({ ...h.manifest('0.2.51'), id, name, contributes: { tabs: [{ name: 'main', title: name }] } });
    h.api.list.mockResolvedValue({
      success: true,
      data: {
        extensions: [h.manifest('1.0.0'), shipped('workspace', '群文件夹'), shipped('searcher', 'Searcher')],
        invalid: [],
        icons: {},
        disabled: [],
        origins: { workspace: 'preinstalled' },
      },
    } as never);
    try {
      await act(async () => {
        root.render(React.createElement(SessionLocalizationProvider, null, React.createElement(ExtensionsSettingsCard)));
      });
      await settle();
      await showInstalled(dom);
      const rows = [...dom.window.document.querySelectorAll('[data-testid^="extension-row-"]')].map((row) => row.getAttribute('data-testid'));
      expect(rows).toContain('extension-row-notes');
      expect(rows).toContain('extension-row-searcher');
      expect(rows).not.toContain('extension-row-workspace');
    } finally {
      h.api.list.mockImplementation(listed!);
    }
  });

  // L11 复核 60: an installed folder this build cannot read (every v1 / v2 App once apiVersion 3 ships) sat in the list
  // with no way to remove it. Control (the parent commit): no button in the row.
  it('an installed folder this build cannot read: the row says why, and Uninstall removes it by its folder name', async () => {
    const listed = h.api.list.getMockImplementation();
    h.api.list.mockResolvedValue({
      success: true,
      data: { extensions: [h.manifest('1.0.0')], invalid: [{ dirName: 'old-notes', reason: REFUSED }], icons: {}, disabled: [] },
    });
    try {
      await act(async () => {
        root.render(React.createElement(SessionLocalizationProvider, null, React.createElement(ExtensionsSettingsCard)));
      });
      await settle();
      await showInstalled(dom);
      const row = dom.window.document.querySelector('[data-testid="extension-row-unreadable"][data-extension-dir="old-notes"]');
      expect(row?.querySelector('.xp-row-error')?.textContent).toBe(translateSessionMessage('extensions.unreadable', { name: 'old-notes', reason: REFUSED }));
      await act(async () => void row!.querySelector('[data-testid="extension-row-unreadable-uninstall"]')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
      expect(h.showConfirm).toHaveBeenCalledOnce();
      await act(async () => void (h.showConfirm.mock.calls[0][0] as { onSuccess: () => void }).onSuccess());
      await settle();
      expect(h.api.uninstall).toHaveBeenCalledWith({ extensionId: 'old-notes' });
    } finally {
      h.api.list.mockImplementation(listed!);
    }
  });

  // L11 复核 60 补看: a machine picked in the device picker that cannot be reached rejects instead of answering — the
  // person is told it failed, as when it answers no. Control (b93c87469d): the rejection went nowhere, no toast.
  it('Uninstall of an unreadable folder on a machine that cannot be reached says it failed', async () => {
    const listed = h.api.list.getMockImplementation();
    h.api.list.mockResolvedValue({
      success: true,
      data: { extensions: [h.manifest('1.0.0')], invalid: [{ dirName: 'old-notes', reason: REFUSED }], icons: {}, disabled: [] },
    });
    h.api.uninstall.mockRejectedValueOnce(new Error('device offline'));
    try {
      await act(async () => {
        root.render(React.createElement(SessionLocalizationProvider, null, React.createElement(ExtensionsSettingsCard)));
      });
      await settle();
      await showInstalled(dom);
      const row = dom.window.document.querySelector('[data-testid="extension-row-unreadable"][data-extension-dir="old-notes"]');
      await act(async () => void row!.querySelector('[data-testid="extension-row-unreadable-uninstall"]')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
      await act(async () => void (h.showConfirm.mock.calls[0][0] as { onSuccess: () => void }).onSuccess());
      await settle();
      // One uninstall for every App (L11 64): the failure reads as it does for a readable one — the words, and Retry.
      expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({
        title: translateSessionMessage('extensions.uninstallFailed'),
        description: 'device offline',
        tier: 'error',
        action: expect.objectContaining({ label: translateSessionMessage('extensions.retry') }),
      }));
    } finally {
      h.api.list.mockImplementation(listed!);
    }
  });
});

// The sheet's 「这版改了什么」 and 「代码在哪」 are those of the version being installed, as main hands them back with what it
// would ask (installFromMarket `consent: return`) — main holds that version's row. Neither the page on screen (here 1.0.0, read before the update check)
// nor the market's current version (here 3.0.0: installing an older one from the history) is that version: matched against
// either, both lines were dropped (A/B 10-07; 复核 96 R3). 2.0.0 asks for a new host, so the sheet opens.
describe('Installing one version from the market: the sheet speaks of that version', () => {
  let dom: JSDOM;
  let root: Root;
  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
  const source = { repo: 'shuxueshuxue/promo-skills', path: '.', commit: '6f46446' + 'a'.repeat(33) };
  const cloudOf = (version: string, releaseNotes: string) => ({
    version, bundleSha256: 'a'.repeat(64), bundleBytes: 10, apiVersion: 3, minAppVersion: '0.2.40', releaseNotes,
    publishedAt: '2026-10-07T00:00:00Z', firstPublishedAt: '2026-10-07T00:00:00Z', firstRun: false, iconUrl: null, deprecated: null, compat: null, newerNeedsApp: null, source,
  });
  const entryOf = (version: string, releaseNotes: string) => ({
    manifest: h.manifest(version, version === '2.0.0' ? ['api.example.com'] : []),
    ref: { extensionId: 'notes', version },
    cloud: cloudOf(version, releaseNotes),
  });
  const saved = { market: h.api.market.getMockImplementation(), marketEntry: h.api.marketEntry.getMockImplementation(), marketUpdates: h.api.marketUpdates.getMockImplementation() };

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    h.api.market.mockResolvedValue({
      success: true,
      data: { extensions: [entryOf('1.0.0', 'the old notes')], invalid: [], errorKind: null, error: null, total: 1, page: 0, hasMore: false, fetchedAt: null },
    } as never);
    h.api.marketEntry.mockResolvedValue({ success: true, data: entryOf('3.0.0', 'what 3.0.0 changed') } as never);
    h.api.marketUpdates.mockResolvedValue({
      success: true,
      data: { checkedAt: '2026-10-07T00:00:00.000Z', updates: { notes: { version: '2.0.0', releaseNotes: 'what 2.0.0 changed' } }, yanked: {}, deprecated: {} },
    } as never);
    (h.api as Record<string, unknown>).installFromMarket = vi.fn(async () => ({
      success: true,
      data: {
        installed: false, outcome: 'ask', id: 'notes', name: 'Notes', version: '2.0.0', asks: true,
        ask: {
          manifest: h.manifest('2.0.0', ['api.example.com']), manifestDigest: 'digest-2', installed: h.manifest('1.0.0'),
          revokedPermissions: ['files:read'], market: { source, releaseNotes: 'what 2.0.0 changed' },
        },
      },
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    h.api.market.mockImplementation(saved.market!);
    h.api.marketEntry.mockImplementation(saved.marketEntry!);
    h.api.marketUpdates.mockImplementation(saved.marketUpdates!);
    dom.window.close();
  });

  it('the sheet says what the installed version changed and that it came from the market', async () => {
    await act(async () => {
      root.render(React.createElement(SessionLocalizationProvider, null, React.createElement(ExtensionsSettingsCard)));
    });
    await settle();
    await showInstalled(dom);
    // 有新版的那一行:名字下面写「有新版 v2.0.0」,行尾那颗按钮是「更新」(#7059 一个按钮走完一生)。
    expect(dom.window.document.querySelector('[data-testid="extension-row-notes"]')?.textContent).toContain('2.0.0');
    const link = dom.window.document.querySelector('[data-testid="extension-row-action-notes"][data-lifecycle="update"]');
    expect(link, 'the row offers the update').not.toBeNull();
    await act(async () => void link!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    await settle();
    expect(h.showConfirm).toHaveBeenCalledOnce();
    const { description } = h.showConfirm.mock.calls[0][0] as { description: string };
    expect(description).toContain('what 2.0.0 changed');
    expect(description).not.toContain('the old notes');
    expect(description).not.toContain('what 3.0.0 changed');
    expect(description).toContain(translateSessionMessage('extensions.consentFromMarket'));
    expect(description).not.toContain('shuxueshuxue/promo-skills');
    expect(description).toContain('api.example.com');
  });
});

// #7059 市场页:官方精选在顶上、按类别分区(次序是清单给的);第一次装一个什么权限都不要的,点「安装」就装,❌ 弹框;
// 要了权限的照旧问。对照(这条之前):零权限的也弹「安装 X?」。
describe('市场页 (#7059)', () => {
  let dom: JSDOM;
  let root: Root;
  let queryClient: QueryClient;
  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
  const source = { repo: 'OpenDCAI/gugu', path: 'extensions/x', commit: '6f46446' + 'a'.repeat(33) };
  const app = (id: string, categories: string[], network: string[] = []) => ({
    manifest: { ...h.manifest('1.0.0', network, []), id, name: `App ${id}`, categories, description: `${id} 的一句话` },
    ref: { extensionId: id, version: '1.0.0' },
    cloud: {
      version: '1.0.0', bundleSha256: 'a'.repeat(64), bundleBytes: 10, apiVersion: 3, minAppVersion: '0.2.40', releaseNotes: '',
      publishedAt: '2026-10-07T00:00:00Z', firstPublishedAt: '2026-10-07T00:00:00Z', firstRun: false, iconUrl: null, deprecated: null, compat: null, newerNeedsApp: null, source, featured: id === 'pomo',
    },
  });
  const listing = [app('arxiv', ['research'], ['export.arxiv.org']), app('pomo', ['productivity']), app('trace', ['developer'])];
  const saved = { market: h.api.market.getMockImplementation() };

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    Object.defineProperty(dom.window.HTMLImageElement.prototype, 'decode', { configurable: true, value: vi.fn(async () => undefined) });
    h.ranking.mockResolvedValue({ data: [], error: null });
    h.api.market.mockResolvedValue({
      success: true,
      data: { extensions: listing, invalid: [], errorKind: null, error: null, total: 3, page: 0, hasMore: false, fetchedAt: null },
    } as never);
    (h.api as Record<string, unknown>).marketReadme = vi.fn(async () => ({ success: true, data: { readme: null } }));
    (h.api as Record<string, unknown>).marketHistory = vi.fn(async () => ({ success: true, data: [] }));
    // Main reads the unpacked package and hands back what it would ask (`return`); `given` installs it.
    (h.api as Record<string, unknown>).installFromMarket = vi.fn(async ({ ref, consent }: { ref: { extensionId: string }; consent?: { kind: string } }) => {
      const entry = listing.find((item) => item.manifest.id === ref.extensionId)!;
      if (consent?.kind === 'given') return { success: true, data: { installed: true, outcome: 'confirmed', id: ref.extensionId } };
      return {
        success: true,
        data: {
          installed: false, outcome: 'ask', id: ref.extensionId, name: entry.manifest.name, version: '1.0.0',
          asks: entry.manifest.permissions.network.length > 0,
          ask: { manifest: entry.manifest, manifestDigest: `digest-${ref.extensionId}`, revokedPermissions: [], market: { source, releaseNotes: '' } },
        },
      };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    h.api.market.mockImplementation(saved.market!);
    dom.window.close();
  });

  const page = () =>
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(SessionLocalizationProvider, null, React.createElement(ExtensionsSettingsCard))
    );
  const render = async (browseAll = true) => {
    await act(async () => {
      root.render(page());
    });
    await settle();
    if (browseAll) await press('[data-testid="extensions-tab-all"]');
  };
  const press = async (selector: string) => {
    const node = dom.window.document.querySelector(selector) as HTMLElement | null;
    expect(node, selector).not.toBeNull();
    await act(async () => void node!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    await settle();
  };

  it('opens on recommendations with no repeated featured App, and categories browse the complete catalog', async () => {
    await render(false);
    const document = dom.window.document;
    expect(document.querySelector('[data-testid="app-featured-pomo"]')).not.toBeNull();
    const chips = [...document.querySelectorAll('[data-testid^="extensions-market-chip-"]')].map((node) =>
      node.getAttribute('data-testid')!.replace('extensions-market-chip-', '')
    );
    expect(chips).toEqual(['all', 'research', 'productivity', 'developer']);
    const tiles = () => [...document.querySelectorAll('[data-testid^="extension-card-"]')].map((node) => node.getAttribute('data-testid'));
    expect(tiles()).toEqual(['extension-card-arxiv', 'extension-card-trace']);
    await press('[data-testid="extensions-market-chip-developer"]');
    expect(tiles()).toEqual(['extension-card-trace']);
    // 选了一类,精选那张不再画(它不一定是这一类的)。
    expect(document.querySelector('[data-testid="app-featured-pomo"]')).toBeNull();
  });

  it('keeps a placeholder until the README and final artwork are ready', async () => {
    let answer!: (value: { success: boolean; data: { readme: string } }) => void;
    let decoded!: () => void;
    const readme = new Promise<{ success: boolean; data: { readme: string } }>((resolve) => { answer = resolve; });
    const image = new Promise<void>((resolve) => { decoded = resolve; });
    (h.api as Record<string, unknown>).marketReadme = vi.fn(() => readme);
    vi.mocked(dom.window.HTMLImageElement.prototype.decode).mockReturnValueOnce(image);
    await render(false);
    const art = () => dom.window.document.querySelector('[data-testid="app-featured-pomo"] .mk-hero-art');
    expect(art()?.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(art()?.querySelector('.mk-hero-big')).toBeNull();
    await act(async () => answer({ success: true, data: { readme: '# Pomo\n\n![Pomo](https://dl.example/pomo/shot.png)\n' } }));
    await settle();
    expect(art()?.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(art()?.querySelector('img')).toBeNull();
    await act(async () => decoded());
    await settle();
    expect(art()?.querySelector('img')?.getAttribute('src')).toBe('https://dl.example/pomo/shot.png');
    expect(art()?.querySelector('[aria-busy="true"]')).toBeNull();
    expect(art()?.querySelector('.mk-hero-big')).toBeNull();
  });

  it.each(['README', 'image'])('shows a %s failure and retries without substituting an icon design', async (failure) => {
    const readme = vi.fn().mockResolvedValueOnce(failure === 'README' ? { success: false, error: 'unreadable' }
      : { success: true, data: { readme: '![Pomo](https://dl.example/pomo/shot.png)' } })
      .mockResolvedValueOnce({ success: true, data: { readme: null } });
    (h.api as Record<string, unknown>).marketReadme = readme;
    if (failure === 'image') vi.mocked(dom.window.HTMLImageElement.prototype.decode).mockRejectedValueOnce(new Error('image unreadable'));
    await render(false);
    const card = () => dom.window.document.querySelector('[data-testid="app-featured-pomo"]');
    expect(card()?.querySelector('[role="alert"]')?.textContent).toContain(translateSessionMessage('extensions.loadFailed'));
    expect(card()?.querySelector('.mk-hero-big')).toBeNull();
    await press('[data-testid="app-featured-pomo"] [role="alert"] button');
    expect(readme).toHaveBeenCalledTimes(2);
    expect(card()?.querySelector('[role="alert"]')).toBeNull();
    // A successful README with no artwork is the one case that uses the icon design.
    expect(card()?.querySelector('.mk-hero-big')).not.toBeNull();
    expect(dom.window.document.querySelector('[data-testid="app-product-page"]')).toBeNull();
  });

  // owner 10-20「每次点进去 apps 页面里面整个 banner image 都是要变一下」:从项目页回来这一页是重新挂上的,精选卡先画图标版、
  // README 取回来再换成截图。一版的 README 不变 ⇒ 再挂上时第一帧就是截图,README 只取一次。
  it('精选卡的截图:离开再进来,第一帧就是截图,不先画图标版', async () => {
    const readme = vi.fn(async () => ({ success: true, data: { readme: '# Pomo\n\n![番茄钟](https://dl.example/pomo/shot.png)\n' } }));
    (h.api as Record<string, unknown>).marketReadme = readme;
    await render(false);
    const art = () => dom.window.document.querySelector('[data-testid="app-featured-pomo"] .mk-hero-art');
    expect(art()?.className).toBe('mk-hero-art is-shot');
    await act(async () => root.render(null));
    expect(art()).toBeNull();
    // 只渲染、不等任何一趟回答:这一刻画出来的就是第一帧。
    act(() => root.render(page()));
    expect(art()?.className).toBe('mk-hero-art is-shot');
    expect(art()?.querySelector('img')?.getAttribute('src')).toBe('https://dl.example/pomo/shot.png');
    await settle();
    expect(readme).toHaveBeenCalledTimes(1);
  });

  it('browses complete New and Popular pages without subtracting featured Apps or capping at six', async () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => app(`p${id}`, ['productivity']));
    many[0]!.cloud.firstPublishedAt = '2026-10-25T00:00:00Z';
    const entries = [...listing, ...many];
    h.api.market.mockResolvedValue({ success: true, data: {
      extensions: entries, invalid: [], errorKind: null, error: null, total: 10, page: 0, hasMore: false, fetchedAt: null,
    } } as never);
    h.ranking.mockResolvedValue({ data: [
      { app_id: 'trace', score: 5 }, { app_id: 'pomo', score: 3 }, { app_id: 'pa', score: 2 }, { app_id: 'arxiv', score: 1 },
    ], error: null } as never);
    await render(false);
    const document = dom.window.document;
    const rows = () => [...document.querySelectorAll('[data-testid^="extension-card-"]')].map((node) => node.getAttribute('data-testid')!.replace('extension-card-', ''));
    const hero = [...document.querySelectorAll('[role="listitem"][data-testid^="app-featured-"]')].map((node) => node.getAttribute('data-testid')!.replace('app-featured-', ''));
    expect(hero).toEqual(['trace', 'pomo', 'pa']);
    expect([...hero, ...rows()].sort()).toEqual(entries.map((item) => item.manifest.id).sort());
    await press('[data-testid="extensions-tab-newest"]');
    expect(document.querySelector('[data-testid="app-featured-pomo"]')).toBeNull();
    expect(rows()).toEqual(['pa', 'arxiv', 'pb', 'pc', 'pd', 'pe', 'pf', 'pg', 'pomo', 'trace']);
    await press('[data-testid="extensions-tab-popular"]');
    expect(rows()).toEqual(['trace', 'pomo', 'pa', 'arxiv']);
    await press('[data-testid="extensions-tab-all"]');
    expect(rows()).toEqual(entries.map((item) => item.manifest.id));
    await press('[data-testid="extensions-market-chip-productivity"]');
    expect(rows()).toEqual(['pomo', ...many.map((item) => item.manifest.id)]);
  });

  it('shows a retry on ranking failure and a distinct empty state after a successful empty retry', async () => {
    h.ranking.mockResolvedValue({ data: null, error: { message: 'ranking denied' } } as never);
    await render(false);
    await press('[data-testid="extensions-tab-popular"]');
    const document = dom.window.document;
    const failed = () => document.querySelector('[data-testid="extensions-market-ranking-error"]');
    expect(failed()?.textContent).toContain(translateSessionMessage('extensions.rankingUnavailable'));
    expect(document.querySelector('[data-testid^="extension-card-"]')).toBeNull();
    h.ranking.mockResolvedValue({ data: [], error: null });
    await press('[data-testid="extensions-market-ranking-error"] button');
    expect(failed()).toBeNull();
    expect(document.querySelector('.mk-empty')?.textContent).toBe(translateSessionMessage('extensions.noPopular'));
  });

  it('reads every catalog page before selecting recommendations and complete New results', async () => {
    const entries = Array.from({ length: 14 }, (_, i) => app(`app-${i}`, ['productivity']));
    h.api.market.mockImplementation((async ({ page }: { page: number }) => ({ success: true, data: {
      extensions: entries.slice(page * 12, (page + 1) * 12), invalid: [], errorKind: null, error: null,
      total: 14, page, hasMore: page === 0, fetchedAt: null,
    } })) as never);
    await render(false);
    expect(h.api.market).toHaveBeenCalledWith({ page: 1, query: '' });
    expect(dom.window.document.querySelectorAll('[data-testid^="extension-card-"]')).toHaveLength(14);
    await press('[data-testid="extensions-tab-newest"]');
    expect(dom.window.document.querySelectorAll('[data-testid^="extension-card-"]')).toHaveLength(14);
  });

  it('第一次装、什么权限都不要的:产品页头上点「安装」就装,不弹框', async () => {
    await render();
    await press('[data-testid="extension-card-pomo"]');
    await press('[data-testid="app-product-action"]');
    expect(h.showConfirm).not.toHaveBeenCalled();
    expect((h.api as unknown as { installFromMarket: ReturnType<typeof vi.fn> }).installFromMarket).toHaveBeenLastCalledWith({
      ref: { extensionId: 'pomo', version: '1.0.0' },
      consent: { kind: 'given', digest: 'digest-pomo' },
    });
  });

  it('要了权限的(这里是联网):照旧先问,点头之前不装', async () => {
    await render();
    await press('[data-testid="extension-card-arxiv"]');
    await press('[data-testid="app-product-action"]');
    const installFromMarket = (h.api as unknown as { installFromMarket: ReturnType<typeof vi.fn> }).installFromMarket;
    expect(installFromMarket.mock.calls.map(([args]) => (args as { consent?: { kind: string } }).consent?.kind)).toEqual(['return']);
    expect(h.showConfirm).toHaveBeenCalledOnce();
    expect((h.showConfirm.mock.calls[0][0] as { description: string }).description).toContain('export.arxiv.org');
  });

  it('一行:名字下面是它是什么(简介第一句),状态只在右边那一格 —— 这台咕咕装不了的写「需要更新咕咕」;只是更新的那版要新版咕咕的照常能装', async () => {
    const blocked = app('arxiv', ['research']);
    const newer = app('trace', ['developer']);
    const entries = [
      { ...blocked, cloud: { ...blocked.cloud, compat: { reason: 'needs-newer-app' as const, minAppVersion: '9.0.0' } } },
      listing[1]!,
      { ...newer, cloud: { ...newer.cloud, newerNeedsApp: '2.0.0' } },
    ];
    h.api.market.mockResolvedValue({
      success: true,
      data: { extensions: entries, invalid: [], errorKind: null, error: null, total: 3, page: 0, hasMore: false, fetchedAt: null },
    } as never);
    await render();
    const document = dom.window.document;
    const sub = (id: string) => document.querySelector(`[data-testid="extension-card-${id}"] .mk-lockup-sub`)?.textContent;
    const word = (id: string) => document.querySelector(`[data-testid="market-row-action-${id}"]`);
    // 简介是「arxiv 的一句话」,没写副标题:名字下面就是它,❌ 写状态或类别。
    expect(sub('arxiv')).toBe('arxiv 的一句话');
    expect(sub('trace')).toBe('trace 的一句话');
    expect(word('arxiv')?.textContent).toBe(translateSessionMessage('extensions.tileNeedsApp'));
    expect(word('arxiv')?.getAttribute('title')).toBe(translateSessionMessage('extensions.needsNewerApp', { version: '9.0.0' }));
    expect(word('trace')?.getAttribute('data-lifecycle')).toBe('get');
    await press('[data-testid="extension-card-trace"]');
    expect(document.querySelector('[data-testid="app-product-newer-needs-app"]')?.textContent).toBe(
      translateSessionMessage('extensions.newerNeedsApp', { version: '2.0.0' })
    );
  });

  // 10-16 实测：市场上 office 0.1.1、预装的 0.1.0 —— 产品页「Update to v0.1.1」,一按就是「another package cannot replace it」。
  // 预装的跟着咕咕更新:货架上新一点的那版对它不算更新。对照：同一个 App 不是预装的，照常出「更新到」。
  for (const [origins, offered] of [[{ pomo: 'preinstalled' }, false], [{ pomo: 'market' }, true]] as const) {
    it(`货架上有比装着的新一版：${'pomo' in origins && origins.pomo === 'preinstalled' ? '预装的不出「更新到」' : '不是预装的照常出「更新到」(对照)'}`, async () => {
      const here = app('pomo', ['productivity']);
      const newer = { ...here, manifest: { ...here.manifest, version: '1.1.0' }, ref: { extensionId: 'pomo', version: '1.1.0' }, cloud: { ...here.cloud, version: '1.1.0' } };
      h.api.market.mockResolvedValue({
        success: true,
        data: { extensions: [newer], invalid: [], errorKind: null, error: null, total: 1, page: 0, hasMore: false, fetchedAt: null },
      } as never);
      h.api.list.mockResolvedValueOnce({ success: true, data: { extensions: [here.manifest], invalid: [], icons: {}, disabled: [], origins } } as never);
      await render();
      await press('[data-testid="extension-card-pomo"]');
      const action = dom.window.document.querySelector('[data-testid="app-product-action"]')?.textContent ?? null;
      // The product page is drawn either way (a missing button would make the arm without an offer pass on nothing).
      expect(action).not.toBeNull();
      expect(action === translateSessionMessage('extensions.updateTo', { version: '1.1.0' })).toBe(offered);
    });
  }

  it('点「类似 App」换到它的产品页', async () => {
    const twin = app('focus', ['productivity']);
    h.api.market.mockResolvedValue({
      success: true,
      data: { extensions: [...listing, twin], invalid: [], errorKind: null, error: null, total: 4, page: 0, hasMore: false, fetchedAt: null },
    } as never);
    await render();
    const document = dom.window.document;
    await press('[data-testid="extension-card-pomo"]');
    // 同一类(效率)的另一个才算类似;别的类、它自己都不在里面。
    const similar = [...document.querySelectorAll('[data-testid^="app-product-similar-"]')].map((node) => node.getAttribute('data-testid'));
    expect(similar).toEqual(['app-product-similar-focus']);
    await press('[data-testid="app-product-similar-focus"]');
    expect(document.querySelector('[data-testid="app-product-page"][data-extension-id="focus"]')).not.toBeNull();
  });

  it('点一格 = 它的产品页,在这一栏里铺开;「‹ App」回到清单', async () => {
    await render();
    await press('[data-testid="extension-card-trace"]');
    expect(dom.window.document.querySelector('[data-testid="app-product-page"][data-extension-id="trace"]')).not.toBeNull();
    expect(dom.window.document.querySelector('[data-testid="extensions-store"]')).toBeNull();
    await press('[data-testid="app-product-back"]');
    expect(dom.window.document.querySelector('[data-testid="extensions-store"]')).not.toBeNull();
  });
});

describe('App variant switching uses the existing install consent', () => {
  let dom: JSDOM;
  let root: Root;
  let queryClient: QueryClient;
  let active: string;
  let asks: boolean;
  const originalList = h.api.list.getMockImplementation();
  const originalUpdates = h.api.marketUpdates.getMockImplementation();
  const originalEntry = h.api.marketEntry.getMockImplementation();
  const variants = ['upstream', 'timeline'].map((name) => ({
    name, base: '1.0.0', dir: name === 'upstream' ? null : '/work/notes@timeline',
    repo: 'https://github.com/example/apps', path: 'notes', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), bytes: 10,
  }));
  const doc = () => dom.window.document;
  const press = async (selector: string) => {
    const element = doc().querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    await act(async () => element!.click());
  };

  beforeEach(() => {
    vi.clearAllMocks();
    active = 'timeline';
    asks = false;
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'navigator', 'MutationObserver'] as const) vi.stubGlobal(key, dom.window[key]);
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    root = createRoot(doc().querySelector('#root')!);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    h.api.list.mockImplementation(async () => ({ success: true, data: { extensions: [h.manifest('1.0.0')], invalid: [], icons: {}, disabled: [], origins: { notes: active === 'upstream' ? 'market' : 'fork' }, variants: { notes: { active, variants } } } }));
    h.api.switchVariant.mockImplementation(async (_id: string, name: string, consent: { kind: string }) => {
      const manifest = h.manifest('1.0.0', [], asks ? ['files:read', 'notifications'] : ['files:read']);
      if (consent.kind === 'return') return { success: true, data: { outcome: 'ask', asks, ask: { manifest, manifestDigest: 'variant-digest', installed: h.manifest('1.0.0'), revokedPermissions: [] } } };
      active = name;
      return { success: true, data: { outcome: 'confirmed', manifest } };
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    dom.window.close();
    vi.unstubAllGlobals();
    h.api.list.mockImplementation(originalList!);
    h.api.marketUpdates.mockImplementation(originalUpdates!);
    h.api.marketEntry.mockImplementation(originalEntry!);
    h.api.switchVariant.mockReset();
  });

  async function openVariantList() {
    await render();
    await showInstalled(dom);
    await until('the installed Notes row', () => !!doc().querySelector('[data-testid="extension-row-notes"]'));
    await press('[data-testid="extension-row-notes"] .mk-name');
    await until('the Notes variants', () => !!doc().querySelector('[data-testid="app-variant-upstream"]'));
  }

  async function render() {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(SessionLocalizationProvider, null, React.createElement(ExtensionsSettingsCard)))));
  }

  it('switches without a dialog when no new permission is needed, then reads the active variant again', async () => {
    await openVariantList();
    await press('[data-testid="app-variant-upstream"]');
    expect(h.showConfirm).not.toHaveBeenCalled();
    expect(h.api.switchVariant.mock.calls).toEqual([
      ['notes', 'upstream', { kind: 'return' }],
      ['notes', 'upstream', { kind: 'given', digest: 'variant-digest' }],
    ]);
    await until('the upstream variant is selected', () => doc().querySelector('[data-testid="app-variant-upstream"]')?.getAttribute('aria-checked') === 'true');
  });

  it.each([false, true])('opens the active fork instead of replacing it with a market update (update listed: %s)', async (listed) => {
    const installFromMarket = vi.fn();
    (h.api as Record<string, unknown>).installFromMarket = installFromMarket;
    h.api.marketEntry.mockResolvedValue({ success: true, data: {
      manifest: h.manifest('2.0.0'), cloud: { compat: null }, ref: { extensionId: 'notes', version: '2.0.0' },
    } } as never);
    h.api.marketUpdates.mockResolvedValue({ success: true, data: {
      checkedAt: '2026-10-26T00:00:00.000Z', yanked: {}, deprecated: {},
      updates: listed ? { notes: { version: '2.0.0' } } : {},
      forkBehind: { notes: { upstream: '2.0.0', behind: 1, commit: 'c'.repeat(40) } },
    } } as never);
    await openVariantList();
    await until('the newer market entry is loaded', () => h.api.marketEntry.mock.calls.length > 0);
    expect(doc().querySelector('[data-testid="app-product-action"]')?.getAttribute('data-lifecycle')).toBe('open');
    expect(doc().querySelector('.mk-banner .xp-note')?.textContent).toContain('2.0.0');
    await press('[data-testid="app-product-action"]');
    expect(installFromMarket).not.toHaveBeenCalled();
    expect(h.showConfirm).not.toHaveBeenCalled();
  });

  it('keeps Apps listed when one has no readable variant metadata', async () => {
    h.api.list.mockImplementation(async () => ({ success: true, data: {
      extensions: [h.manifest('1.0.0'), { ...h.manifest('1.0.0'), id: 'other', name: 'Other' }],
      invalid: [], icons: {}, disabled: [], variants: { other: { active, variants } },
    } }));
    await render();
    await showInstalled(dom);
    await until('both installed Apps', () => !!doc().querySelector('[data-testid="extension-row-notes"]') && !!doc().querySelector('[data-testid="extension-row-other"]'));
    expect(h.api.list).toHaveBeenCalledOnce();
    await press('[data-testid="extension-row-notes"]');
    expect(doc().querySelector('[data-testid="app-product-page"]')).not.toBeNull();
    expect(doc().querySelector('[data-testid="app-variants"]')).toBeNull();
    await press('[data-testid="app-product-back"]');
    await press('[data-testid="extension-row-other"]');
    expect(doc().querySelector('[data-testid="app-variants"]')).not.toBeNull();
  });

  it('waits for the existing consent dialog before installing a variant with additional permissions', async () => {
    asks = true;
    await openVariantList();
    await press('[data-testid="app-variant-upstream"]');
    expect(h.api.switchVariant).toHaveBeenCalledExactlyOnceWith('notes', 'upstream', { kind: 'return' });
    expect(h.showConfirm).toHaveBeenCalledOnce();
    const prompt = h.showConfirm.mock.calls[0]![0] as { onSuccess: () => void };
    await act(async () => prompt.onSuccess());
    expect(h.api.switchVariant).toHaveBeenLastCalledWith('notes', 'upstream', { kind: 'given', digest: 'variant-digest' });
  });
});
