import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 10-19 on mac1: 论文共读's reader names the group panel after its paper; its back button is `location.href = 'shelf.html'`,
 * another document in the same page, and the shelf says no title — the panel kept the paper's title over the shelf. What
 * a page says about itself (title / badge / error) lasts as long as the document that said it: main hears every commit of
 * a next one (`did-navigate`) and tells the window `newDocument`, which puts the slot back on the manifest's title — as
 * the old document's open files end there (file-sync.ts). Control (the parent commit): nothing after the navigation.
 */

const READER = 7;
const OTHER_READER = 8;
const BACKGROUND = 9;
const UNBOUND = 10;
const review = vi.hoisted(() => ({
  resource: async (id: string) => id,
  background: null as number | null,
}));
const navigated = new Map<number, (() => void)[]>();
const contentsOf = (id: number) => ({
  id,
  isDestroyed: () => false,
  hostWebContents: { id: 42 },
  session: {},
  once: () => undefined,
  on: (event: string, listener: () => void) => {
    if (event === 'did-navigate') navigated.set(id, [...(navigated.get(id) ?? []), listener]);
  },
  send: vi.fn(),
});
/** The page's main frame committed another document. */
const navigate = (id: number) => {
  for (const listener of navigated.get(id) ?? []) listener();
};
const contents = new Map([READER, OTHER_READER, BACKGROUND, UNBOUND].map(id => [id, contentsOf(id)]));
const embedder = { id: 42, isDestroyed: () => false, send: vi.fn() };

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    on: vi.fn(),
  },
  webContents: { fromId: (id: number) => (id === 42 ? embedder : contents.get(id)) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({
  extensionIdForSession: () => 'paper-club',
  isExtensionSessionConfigured: () => true,
}));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => review.background }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    grantedCapabilities: () => ['files:read'],
    hasCapability: () => true,
    get: () => ({ manifest: { name: '论文共读' } }),
  }),
}));
vi.mock('@main/core/extensions/app-files', () => ({
  resourceChatOf: (id: string) => review.resource(id),
  changedGroupFiles: async (chat: string, _reader: string | null, wanted: { ids: string[] }) => ({ entries: wanted.ids.map(id => ({ id, chat })), gone: [] }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { bindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost, stopPageWatches, notifyGroupWorkspaceChanged } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');

registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const call = (sender: number, method: string, args: Record<string, unknown>) =>
  handle({ sender: { id: sender, session: {} } }, { method, args }) as Promise<{ ok: boolean; error?: string }>;

const CHAT = '0b000000-0000-4000-8000-00000000c019';
const deliver = vi.fn((_origin: unknown, _action: unknown) => Promise.resolve());
const slot = { extensionId: 'paper-club', sessionId: null, tabId: 'slot-1', embedderId: 42 };

beforeEach(async () => {
  review.resource = async id => id;
  review.background = null;
  for (const id of [READER, OTHER_READER, BACKGROUND, UNBOUND]) {
    stopPageWatches(id);
    contents.get(id)!.send.mockClear();
  }
  deliver.mockClear();
  setExtensionBridgeHost({
    deliver,
    presentation: () => ({ locale: 'zh', themeMode: 'dark' as const, fullscreen: false, windowFocused: true }),
  });
  await bindExtensionSurface({ webContentsId: READER, extensionId: 'paper-club', tabId: 'slot-1', tabKind: 'paper-club.shelf', conversation: CHAT });
});

const { extensionProjections } = await import('./extension-projection-bridge');
describe('what a page says about itself goes with its document', () => {
  it('closes projection viewers on the real document and unbind paths', async () => {
    const { unbindExtensionSurface } = await import('./extension-bridge');
    const closed = vi.spyOn(extensionProjections, 'closePage');
    try {
      navigate(READER);
      expect(closed).toHaveBeenLastCalledWith(READER);
      unbindExtensionSurface(READER);
      expect(closed).toHaveBeenCalledTimes(2);
    } finally { closed.mockRestore(); }
  });

  it('a watch waiting for its first binding cannot register in a later document', async () => {
    const args = { watchId: '1', place: { chat: CHAT }, on: true };
    const old = call(UNBOUND, 'filesWatch', args);
    navigate(UNBOUND);
    await bindExtensionSurface({ webContentsId: UNBOUND, extensionId: 'paper-club', tabId: 'slot-3', tabKind: 'paper-club.shelf', conversation: CHAT });
    expect(await old).toMatchObject({ ok: true });
    expect(await call(UNBOUND, 'filesWatch', args)).toMatchObject({ ok: true });
  });

  it.each([READER, BACKGROUND])('a pending watch from old document %s cannot occupy a new subscription id', async (page) => {
    if (page === BACKGROUND) review.background = BACKGROUND;
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    review.resource = async id => {
      if (first) { first = false; entered(); await hold; }
      return id;
    };
    const old = call(page, 'filesWatch', { watchId: '1', place: { chat: CHAT }, on: true });
    await started;
    navigate(page);
    release();
    await old;
    expect(await call(page, 'filesWatch', { watchId: '1', place: { chat: CHAT }, on: true })).toMatchObject({ ok: true });
  });

  it('reloading one page does not revoke another page watching the same chat with the same id', async () => {
    await bindExtensionSurface({ webContentsId: OTHER_READER, extensionId: 'paper-club', tabId: 'slot-2', tabKind: 'paper-club.shelf', conversation: CHAT });
    const args = { watchId: '1', place: { chat: CHAT }, on: true };
    expect(await call(READER, 'filesWatch', args)).toMatchObject({ ok: true });
    expect(await call(OTHER_READER, 'filesWatch', args)).toMatchObject({ ok: true });
    navigate(READER);
    await notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: ['changed-file'] }]);
    const fileEvents = (id: number) => contents.get(id)!.send.mock.calls.filter(([, event]) => event?.type === 'filesChanged');
    expect(fileEvents(READER)).toHaveLength(0);
    expect(fileEvents(OTHER_READER)).toHaveLength(1);
  });

  it('a background document also releases subscription ids on navigation', async () => {
    review.background = BACKGROUND;
    const args = { watchId: '1', place: { chat: CHAT }, on: true };
    expect(await call(BACKGROUND, 'filesWatch', args)).toMatchObject({ ok: true });
    navigate(BACKGROUND);
    expect(await call(BACKGROUND, 'filesWatch', args)).toMatchObject({ ok: true });
  });

  it('the old document\'s watches stop, allowing the new runtime to register its subscription id again', async () => {
    const args = { watchId: '1', place: { chat: CHAT }, on: true };
    expect(await call(READER, 'filesWatch', args)).toMatchObject({ ok: true });
    navigate(READER);
    expect(await call(READER, 'filesWatch', args)).toMatchObject({ ok: true });
  });

  it('reader → shelf: the reader named the slot; the shelf’s document takes it back, and names it again only if it says so', async () => {
    expect(await call(READER, 'setTabTitle', { title: 'Attention Is All You Need' })).toMatchObject({ ok: true });
    expect(await call(READER, 'setTabBadge', { badge: 2 })).toMatchObject({ ok: true });
    expect(deliver.mock.calls).toEqual([
      [slot, { kind: 'setTabTitle', title: 'Attention Is All You Need' }],
      [slot, { kind: 'setTabBadge', badge: 2 }],
    ]);

    deliver.mockClear();
    navigate(READER);
    expect(deliver.mock.calls).toEqual([[slot, { kind: 'newDocument' }]]);

    // Into the reader again: it names the slot, and the move back takes it back again.
    await call(READER, 'setTabTitle', { title: 'Chain-of-Thought Prompting' });
    navigate(READER);
    expect(deliver.mock.calls.slice(1)).toEqual([
      [slot, { kind: 'setTabTitle', title: 'Chain-of-Thought Prompting' }],
      [slot, { kind: 'newDocument' }],
    ]);
  });

  it('bound again (a task’s tab binds at every dom-ready): one navigation is told once', async () => {
    await bindExtensionSurface({ webContentsId: READER, extensionId: 'paper-club', tabId: 'slot-1', tabKind: 'paper-club.shelf', conversation: CHAT });
    navigate(READER);
    expect(deliver.mock.calls).toEqual([[slot, { kind: 'newDocument' }]]);
  });
});
