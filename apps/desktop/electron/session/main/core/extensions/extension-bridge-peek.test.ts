import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G1 (看板 10-19): `files.openWith(file, { peek: true })` opens beside the page that asked — told to the slot that page is
 * drawn in (`peek`), the page left as it is. A chat file nobody here opens shows in the host's preview there, so it is not
 * refused for want of an App; a folder's file on this computer goes as its workspace and path. Without `peek`, as before.
 */

const PAGE = 7;
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: vi.fn() });
const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn), on: vi.fn() },
  webContents: { fromId: (id: number) => contentsOf(id) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'kanban', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => [], hasCapability: () => true, get: () => ({ manifest: { name: 'Kanban' } }) }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const CHAT = '0b000000-0000-4000-8000-0000000000a1';
const file = { document: false, contentType: 'application/pdf', version: 3, size: 1024 };
const local = { kind: 'local', place: { project: 'p-1' }, projectId: 'p-1', workspaceId: 'w-1', path: 'docs/plan.html', absolutePath: '/repo/docs/plan.html', name: 'plan.html', ask: false };
const pdfApp = { extensionId: 'pdf', tabKind: 'pdf.viewer', tabTitle: 'PDF', app: { name: 'PDF' }, onlyTab: true, suffix: '.pdf' };
const chooser = vi.hoisted(() => ({ kind: 'none' as string }));
// Where the file is and who opens it are app-files' (their own tests); here, what the bridge does with the answer.
vi.mock('@main/core/extensions/app-files', () => ({
  resourceChatOf: async (chatId: string) => chatId,
  openWithTarget: vi.fn(async (_page: unknown, args: { ref: { project?: string } }) =>
    args.ref.project ? { kind: 'peek', target: local } : { kind: 'chat', target: { chatId: CHAT, itemId: 'item-1', name: 'deck.pdf', typedName: 'deck.pdf', file } }),
  openerChoice: () => (chooser.kind === 'none' ? { kind: 'none' } : { kind: 'one', candidate: pdfApp }),
}));

const { bindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const openWith = (args: Record<string, unknown>) =>
  handle({ sender: { id: PAGE, session: {} } }, { method: 'filesOpenWith', args }) as Promise<{ ok: boolean; value?: unknown; code?: string }>;
const deliver = vi.fn((_origin: unknown, _action: unknown) => Promise.resolve());
const actions = () => deliver.mock.calls.map(([, action]) => action);

beforeEach(async () => {
  deliver.mockClear();
  chooser.kind = 'none';
  setExtensionBridgeHost({ deliver, presentation: () => ({ locale: 'en', themeMode: 'light' as const, fullscreen: false, windowFocused: true }) });
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'kanban', tabId: 'dock', tabKind: 'kanban.board' });
});

describe('files.openWith(file, { peek: true }): beside the page that asked (G1)', () => {
  it('a chat file nobody here opens: to the page\'s slot, for the host\'s preview — not refused', async () => {
    expect(await openWith({ ref: { id: 'item-1' }, peek: true })).toEqual({ ok: true, value: undefined });
    expect(deliver.mock.calls[0]![0]).toMatchObject({ sessionId: null, tabId: 'dock' });
    expect(actions()).toEqual([
      { kind: 'peek', target: { kind: 'chat', detail: { chatId: CHAT, itemId: 'item-1', name: 'deck.pdf', typedName: 'deck.pdf', file, choice: { kind: 'none' } } } },
    ]);
  });

  it('a chat file an App opens: that App, beside the page', async () => {
    chooser.kind = 'one';
    expect(await openWith({ ref: { id: 'item-1' }, peek: true })).toMatchObject({ ok: true });
    expect(actions()).toEqual([{ kind: 'peek', target: expect.objectContaining({ kind: 'chat', detail: expect.objectContaining({ choice: { kind: 'one', candidate: pdfApp } }) }) }]);
  });

  it("a project's file: its workspace and path, beside the page", async () => {
    expect(await openWith({ ref: { project: 'p-1', id: 'docs/plan.html' } })).toMatchObject({ ok: true });
    expect(actions()).toEqual([{ kind: 'peek', target: local }]);
  });

  it('without peek: the chat previews the same unclaimed file, without refusing the caller', async () => {
    expect(await openWith({ ref: { id: 'item-1' } })).toMatchObject({ ok: true });
    expect(actions()).toEqual([{ kind: 'openWith', detail: { chatId: CHAT, itemId: 'item-1', name: 'deck.pdf', typedName: 'deck.pdf', file, choice: { kind: 'none' } } }]);
  });
});
