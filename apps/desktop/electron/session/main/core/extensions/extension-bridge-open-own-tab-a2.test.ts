import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionHostActionResult } from '@shared/extensions/host-actions';

/**
 * A2 (data-lens 评审), the desktop's main: `files.openWith(file, { tab })` — a page opens a chat file in a tab of its
 * own App that claims it: no 「打开方式」, the person's 「始终用它」 neither read nor written. The App is the bound
 * caller's (its page's session), never the page's to say. Without `tab`, everything as before (the controls).
 *
 * app-files is mocked as in extension-bridge-peek.test.ts; who opens what is the shared `file-openers` (pure), over
 * Data Lens and an Office that both claim .xlsx in chat. app-files is expected to offer, beside `openerChoice`,
 * `ownTabChoice(typedName, extensionId, tab)` — the same apps, the shared answer.
 */

const PAGE = 7; // a Data Lens card (its widget tab), the caller
const OFFICE_PAGE = 8; // an Office tab, already showing the file in T8
const LENS_PAGE = 9; // the Data Lens explore page about to open (T7)
const contents = new Map<number, { id: number; send: ReturnType<typeof vi.fn> } & Record<string, unknown>>();
const contentsOf = (id: number) => {
  if (!contents.has(id)) contents.set(id, { id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: { id }, once: () => undefined, on: () => undefined, send: vi.fn() });
  return contents.get(id)!;
};
const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn), on: vi.fn() },
  webContents: { fromId: (id: number) => contentsOf(id) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({
  extensionIdForSession: (session: { id: number }) => (session.id === OFFICE_PAGE ? 'office' : 'data-lens'),
  isExtensionSessionConfigured: () => true,
}));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => [], hasCapability: () => true, get: () => ({ manifest: { name: 'Data Lens' } }) }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const CHAT = '0b000000-0000-4000-8000-0000000000a2';
const file = { document: false, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', version: 2, size: 4096 };
const state = vi.hoisted(() => ({ defaults: {} as Record<string, string>, rememberedReads: 0 }));
vi.mock('@main/core/extensions/app-files', async () => {
  const core = await vi.importActual<typeof import('@shared/extensions/app-files-core')>('@shared/extensions/app-files-core');
  const openers = await vi.importActual<typeof import('@shared/extensions/file-openers')>('@shared/extensions/file-openers');
  const { EXTENSION_API_VERSION, parseExtensionManifest } = await vi.importActual<typeof import('@shared/extensions/manifest')>('@shared/extensions/manifest');
  const apps = [
    parseExtensionManifest({
      id: 'data-lens', name: 'Data Lens', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
      contributes: { tabs: [
        { name: 'card', title: 'Data Lens', entry: 'card.html' },
        { name: 'explore', title: 'Data Lens', entry: 'explore.html', opensFiles: { chat: ['.csv', '.xlsx', '.sqlite'] } },
      ] },
    }),
    parseExtensionManifest({
      id: 'office', name: '咕咕办公', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
      contributes: { tabs: [{ name: 'sheet', title: 'Office', entry: 'sheet.html', opensFiles: { chat: ['.xlsx'] } }] },
    }),
  ];
  const own = (openers as unknown as { requireOwnTabChoice?: (...args: unknown[]) => unknown }).requireOwnTabChoice;
  return {
    AppFileError: core.AppFileError,
    resourceChatOf: vi.fn(async (chatId: string) => chatId),
    openWithTarget: vi.fn(async (_page: unknown, args: { ref: { workspace?: string } }) =>
      args.ref.workspace
        ? { kind: 'session', target: { sessionId: 's-1', path: 'data/sales.xlsx' } }
        : { kind: 'chat', target: { chatId: CHAT, itemId: 'item-1', name: 'sales.xlsx', typedName: 'sales.xlsx', file } }),
    openerChoice: (typedName: string, ask = false) => openers.openerChoice(typedName, apps, 'chat', (key) => { state.rememberedReads++; return state.defaults[key] ?? null; }, ask),
    ownTabChoice: (typedName: string, extensionId: string, tab: string) => (own ? own(typedName, apps, 'chat', extensionId, tab) : null),
  };
});

const { bindExtensionSurface, unbindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost } = await import('./extension-bridge');
const { openWithTarget } = await import('./app-files');
const { fileSync } = await import('./file-sync');
const { EXTENSION_BRIDGE_CHANNEL, EXTENSION_BRIDGE_EVENT_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const openWith = (args: Record<string, unknown>) =>
  handle({ sender: { id: PAGE, session: {} } }, { method: 'filesOpenWith', args, gesture: true }) as Promise<{ ok: boolean; value?: unknown; code?: string; message?: string }>;
const deliver = vi.fn<(_origin: unknown, _action: unknown) => Promise<ExtensionHostActionResult>>(() => Promise.resolve());
const actions = () => deliver.mock.calls.map(([, action]) => action as { kind: string; detail?: { choice?: unknown }; onlyIfOpen?: string });
const chosen = () => actions().filter((action) => action.kind === 'openWith' || action.kind === 'peek').map((action) => action.detail?.choice ?? (action as { target?: { detail?: { choice?: unknown } } }).target?.detail?.choice);
const ref = { chat: CHAT, id: 'item-1' };
const lensExplore = { kind: 'one', candidate: expect.objectContaining({ extensionId: 'data-lens', tabKind: 'data-lens.explore' }) };

beforeEach(async () => {
  deliver.mockClear();
  vi.mocked(openWithTarget).mockClear();
  state.defaults = {};
  state.rememberedReads = 0;
  setExtensionBridgeHost({ deliver, presentation: () => ({ locale: 'en', themeMode: 'light' as const, fullscreen: false, windowFocused: true }) });
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'data-lens', tabId: 'card-1', tabKind: 'data-lens.card', conversation: CHAT });
});

describe('openWith(file, { tab }): its own tab, no 「打开方式」 (A2 T3/T4)', () => {
  it.each(['preview', 'pinned'] as const)('folder redesign carries %s through the real desktop host', async (intent) => {
    expect(await openWith({ ref, tab: 'explore', intent })).toMatchObject({ ok: true });
    expect(actions()).toContainEqual(expect.objectContaining({ kind: 'openWith', detail: expect.objectContaining({ intent }) }));
  });

  it('folder redesign defaults to preview and refuses invalid intent before opening', async () => {
    expect(await openWith({ ref, tab: 'explore' })).toMatchObject({ ok: true });
    expect(actions()).toContainEqual(expect.objectContaining({ kind: 'openWith', detail: expect.objectContaining({ intent: 'preview' }) }));
    deliver.mockClear();
    expect(await openWith({ ref, intent: 'permanent' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(actions()).toEqual([]);
  });

  it('T3: Data Lens and Office both open .xlsx — { tab: \'explore\' } opens Data Lens\'s explore, nobody is asked', async () => {
    expect(await openWith({ ref, tab: 'explore' })).toMatchObject({ ok: true });
    expect(chosen()).toEqual([lensExplore]);
  });

  it('T4: the person\'s 「始终用它」 is Office — { tab } still opens its own tab, and the remembered choice is as it was', async () => {
    state.defaults = { 'chat:.xlsx': 'office.sheet' };
    expect(await openWith({ ref, tab: 'explore' })).toMatchObject({ ok: true });
    expect(chosen()).toEqual([lensExplore]);
    expect(state.defaults).toEqual({ 'chat:.xlsx': 'office.sheet' });
    expect(state.rememberedReads).toBe(0);
  });

  it('T5 (control, green before and after): without tab, the remembered Office opens it; with none remembered, the person picks', async () => {
    state.defaults = { 'chat:.xlsx': 'office.sheet' };
    expect(await openWith({ ref })).toMatchObject({ ok: true });
    state.defaults = {};
    expect(await openWith({ ref })).toMatchObject({ ok: true });
    expect(chosen()).toEqual([
      { kind: 'one', candidate: expect.objectContaining({ tabKind: 'office.sheet' }) },
      expect.objectContaining({ kind: 'choose' }),
    ]);
  });

  it('{ tab, peek }: its own tab, beside the page', async () => {
    expect(await openWith({ ref, tab: 'explore', peek: true })).toMatchObject({ ok: true });
    expect(actions().map((action) => action.kind)).toEqual(['peek']);
    expect(chosen()).toEqual([lensExplore]);
  });
});

describe('only its own tab, and only one that claims the file (A2 T6)', () => {
  it('still refuses an unreadable chat file before choosing its own tab', async () => {
    vi.mocked(openWithTarget).mockRejectedValueOnce(Object.assign(new Error('Unreadable file'), { code: 'denied' }));
    expect(await openWith({ ref, tab: 'explore' })).toMatchObject({ ok: false, code: 'denied' });
    expect(actions()).toEqual([]);
  });

  it.each([
    ['its own tab that does not claim .xlsx', { tab: 'card' }],
    ['a tab it does not have', { tab: 'nope' }],
    ['another App\'s tab, spelled as a kind', { tab: 'office.sheet' }],
    ['another App\'s tab, by its bare name', { tab: 'sheet' }],
    ['a forged caller id', { extensionId: 'office', tab: 'sheet' }],
    ['not a name', { tab: 42 }],
    ['an empty name', { tab: '' }],
    ['a null name', { tab: null }],
    ['a whitespace name', { tab: '   ' }],
    ['tab with ask (「用别的 App 打开」 is the person\'s pick)', { tab: 'explore', ask: true }],
  ])('T6: %s — invalid, nothing opened', async (_name, options) => {
    expect(await openWith({ ref, ...options })).toMatchObject({ ok: false, code: 'invalid' });
    expect(chosen()).toEqual([]);
  });

  it('T6: a working copy\'s file with tab — invalid (chat files only), its session pane not opened', async () => {
    expect(await openWith({ ref: { workspace: 'session:s-1', id: 'data/sales.xlsx' }, tab: 'explore' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(actions()).toEqual([]);
  });
});

describe('{ tab, at }: the place goes to its own tab (A2 T7)', () => {
  afterEach(() => unbindExtensionSurface(LENS_PAGE));

  it('T7: the explore page that opens on the file is told the place, as a file link tells it', async () => {
    expect(await openWith({ ref, tab: 'explore', at: { sheet: 'Q3' } })).toMatchObject({ ok: true });
    expect(chosen()).toEqual([lensExplore]);
    await bindExtensionSurface({ webContentsId: LENS_PAGE, extensionId: 'data-lens', tabId: 'explore-1', tabKind: 'data-lens.explore', conversation: CHAT, itemId: 'item-1' });
    await vi.waitFor(() => expect(contentsOf(LENS_PAGE).send).toHaveBeenCalledWith(EXTENSION_BRIDGE_EVENT_CHANNEL,
      expect.objectContaining({ type: 'link', tab: 'explore', query: { sheet: 'Q3' }, file: 'item-1' })));
  });
});

describe('a file already open in another App\'s tab (A2 T8, the fast path)', () => {
  beforeEach(async () => {
    await bindExtensionSurface({ webContentsId: OFFICE_PAGE, extensionId: 'office', tabId: 'sheet-1', tabKind: 'office.sheet', conversation: CHAT, itemId: 'item-1' });
    vi.spyOn(fileSync, 'openCount').mockImplementation((id) => (id === OFFICE_PAGE ? 1 : 0));
  });
  afterEach(() => { unbindExtensionSurface(OFFICE_PAGE); unbindExtensionSurface(LENS_PAGE); vi.restoreAllMocks(); });

  it('T8: { tab } does not bring Office\'s tab forward — it opens its own', async () => {
    expect(await openWith({ ref, tab: 'explore' })).toMatchObject({ ok: true });
    expect(actions().filter((action) => action.kind === 'openChatFile')).toEqual([]);
    expect(chosen()).toEqual([lensExplore]);
  });

  it('T8 (control, green before and after): without tab, the tab already showing it is shown', async () => {
    expect(await openWith({ ref })).toMatchObject({ ok: true });
    expect(actions()[0]).toMatchObject({ kind: 'openChatFile', onlyIfOpen: 'office.sheet' });
  });

  it('resumes its own already-open claiming tab, even with Office also open', async () => {
    await bindExtensionSurface({ webContentsId: LENS_PAGE, extensionId: 'data-lens', tabId: 'explore-1', tabKind: 'data-lens.explore', conversation: CHAT, itemId: 'item-1' });
    vi.mocked(fileSync.openCount).mockImplementation((id) => id === OFFICE_PAGE || id === LENS_PAGE ? 1 : 0);
    expect(await openWith({ ref, tab: 'explore' })).toMatchObject({ ok: true });
    expect(actions()[0]).toMatchObject({ kind: 'openChatFile', onlyIfOpen: 'data-lens.explore' });
  });

  it('refuses a stale live binding that no longer claims the file before presenting it', async () => {
    await bindExtensionSurface({ webContentsId: LENS_PAGE, extensionId: 'data-lens', tabId: 'stale-card', tabKind: 'data-lens.card', conversation: CHAT, itemId: 'item-1' });
    vi.mocked(fileSync.openCount).mockImplementation((id) => id === LENS_PAGE ? 1 : 0);
    expect(await openWith({ ref, tab: 'card' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(actions()).toEqual([]);
  });
});
