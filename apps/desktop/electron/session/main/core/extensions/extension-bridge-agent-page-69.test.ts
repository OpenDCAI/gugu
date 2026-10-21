import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 摩擦单 F69 (统筹 05:47), owner 10-14: the check’s page is worked by the agent that asks — the group’s files for real, as
 * that agent; what would reach the person’s screen is handed back to the agent instead, and answered as done (each verb’s
 * `toAgent` in `BRIDGE_VERBS`). The group’s real page, the control, does each of them as the person.
 */

const REAL = 7;
const CHECK = 9;
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: null, session: {}, once: () => undefined, on: () => undefined, send: () => undefined });

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    on: vi.fn(),
  },
  clipboard: { writeText: vi.fn() },
  shell: {},
  webContents: { fromId: (id: number) => ([REAL, CHECK].includes(id) ? contentsOf(id) : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'board', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    grantedCapabilities: () => ['files:read', 'files:write'],
    hasCapability: () => true,
    get: () => ({ manifest: { name: 'Board', contributes: { tabs: [] } } }),
  }),
  extensionDataRoot: () => '/data/board',
}));
const data = { writeExtensionData: vi.fn(), readExtensionData: vi.fn(), listExtensionData: vi.fn() };
vi.mock('@main/core/extensions/extension-data', () => data);
const programs = { callFromPage: vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }] })) };
vi.mock('@main/core/extensions/extension-programs', () => ({ extensionPrograms: programs, onExtensionProgramNotification: () => () => undefined }));
// The roster: the agent that works the check's page, and its session (owner 10-14).
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ agentIdsBySession: async () => new Map([['session-agent', 'user:0a000000-0000-4000-8000-000000000069']]) }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const CHAT = '0b000000-0000-4000-8000-000000000069';
const TODAY = { id: '0c000000-0000-4000-8000-000000000001', chat: CHAT, name: 'today.board.json', displayName: 'today', contentType: 'application/json', type: 'json' };
const files = {
  listAppFiles: vi.fn(async () => [{ ...TODAY }]),
  openAppFile: vi.fn(async () => ({ entry: { ...TODAY }, docName: `${TODAY.id}@1`, access: 'rw', self: { userId: 'user:u', name: 'Ann' } })),
  closeAppFile: vi.fn(() => undefined),
  createAppFile: vi.fn(async () => ({ id: 'real' })),
  renameAppFile: vi.fn(async () => ({ id: 'real' })),
  removeAppFile: vi.fn(async () => undefined),
  replaceAppFile: vi.fn(async () => ({ id: 'real' })),
  uploadAppFiles: vi.fn(async () => [{ id: 'real' }]),
  pickFilesToUpload: vi.fn(async () => []),
  // A chat ref found as the page finds it (by entry, id or name): the file it names.
  openWithTarget: vi.fn(async () => ({ kind: 'chat', target: { chatId: CHAT, itemId: TODAY.id, name: TODAY.name, typedName: TODAY.name } })),
};
vi.mock('@main/core/extensions/app-files', () => files);

const { bindExtensionSurface, registerExtensionBridge, checkReadingsOf } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const call = (sender: number, method: string, args: Record<string, unknown> = {}) =>
  handle({ sender: { id: sender, session: {} } }, { method, args }) as Promise<{ ok: boolean; value?: unknown; code?: string }>;

const AGENT = '0a000000-0000-4000-8000-000000000069';

beforeEach(async () => {
  for (const fn of Object.values(files)) fn.mockClear();
  await bindExtensionSurface({ webContentsId: REAL, extensionId: 'board', tabId: 'slot', tabKind: 'board.main', chatId: CHAT });
  await bindExtensionSurface({
    webContentsId: CHECK,
    extensionId: 'board',
    tabId: 'extension-check:9',
    tabKind: 'board.main',
    chatId: CHAT,
    operator: { kind: 'agent', id: `user:${AGENT}` },
  });
});

describe('the check’s page works as its operator (摩擦单 F69, owner 10-14)', () => {
  it('what it makes, renames, replaces and removes is done for real, as the agent; the group’s page as the person', async () => {
    const ref = { chat: CHAT, id: TODAY.id };
    const asAgent = expect.objectContaining({ pageId: CHECK, asAgent: AGENT });
    await call(CHECK, 'filesList', { place: { chat: CHAT } });
    await call(CHECK, 'filesOpen', { ref });
    await call(CHECK, 'filesCreate', { place: { chat: CHAT }, name: 'scores.board.json', content: '{}' });
    await call(CHECK, 'filesRename', { ref, name: 'monday.board.json' });
    await call(CHECK, 'filesReplace', { ref, file: { name: '', contentType: 'application/json', bytes: new ArrayBuffer(1) }, expectedVersion: 4 });
    await call(CHECK, 'filesRemove', { ref });
    for (const fn of [files.listAppFiles, files.openAppFile, files.createAppFile, files.renameAppFile, files.replaceAppFile, files.removeAppFile]) {
      expect(fn).toHaveBeenCalledWith(asAgent, expect.anything());
    }
    expect(checkReadingsOf(CHECK)).toBeNull();
    // Control: the group’s real page, as the person.
    await call(REAL, 'filesCreate', { place: { chat: CHAT }, name: 'scores.board.json', content: '{}' });
    expect(files.createAppFile).toHaveBeenLastCalledWith(expect.not.objectContaining({ asAgent: expect.anything() }), expect.anything());
  });

  it('what would reach the person’s screen is handed back to the agent and answered as done: the clipboard, a browser tab', async () => {
    expect(await call(CHECK, 'clipboardWriteText', { text: 'hi' })).toEqual({ ok: true, value: undefined });
    expect(await call(CHECK, 'openBrowserTab', { url: 'https://example.com' })).toEqual({ ok: true, value: undefined });
    const { clipboard } = await import('electron');
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(checkReadingsOf(CHECK)?.shown).toEqual([
      { verb: 'clipboardWriteText', detail: '{"text":"hi"}' },
      { verb: 'openBrowserTab', detail: '{"url":"https://example.com"}' },
    ]);
    // Control: the real page writes the clipboard.
    await call(REAL, 'clipboardWriteText', { text: 'hi' });
    expect(clipboard.writeText).toHaveBeenCalledWith('hi');
  });

  it('a file to save comes back as its link, for the agent to read itself; a picker is the person’s, bytes the App has are uploaded as the agent', async () => {
    expect(await call(CHECK, 'filesDownload', { ref: { chat: CHAT, id: TODAY.id } })).toEqual({ ok: true, value: true });
    // Named by its id alone, or by its name (review 83fad65916): the same link, the file found as the agent finds it.
    for (const ref of [{ id: TODAY.id }, { chat: CHAT, name: TODAY.name }]) {
      expect(await call(CHECK, 'filesDownload', { ref })).toEqual({ ok: true, value: true });
      expect(files.openWithTarget).toHaveBeenLastCalledWith(expect.objectContaining({ asAgent: AGENT }), { ref });
    }
    expect(await call(CHECK, 'filesUpload', { place: { chat: CHAT }, pick: true })).toEqual({ ok: true, value: [] });
    expect(files.pickFilesToUpload).not.toHaveBeenCalled();
    expect(checkReadingsOf(CHECK)?.shown).toEqual([
      ...[1, 2, 3].map(() => ({ verb: 'filesDownload', detail: `gugu-file://${TODAY.id}` })),
      { verb: 'filesUpload', detail: `{"place":{"chat":"${CHAT}"},"pick":true}` },
    ]);
    const file = { name: 'notes.md', contentType: 'text/markdown', bytes: new ArrayBuffer(1) };
    expect(await call(CHECK, 'filesUpload', { place: { chat: CHAT }, files: [file] })).toEqual({ ok: true, value: [{ id: 'real' }] });
    expect(files.uploadAppFiles).toHaveBeenCalledWith(expect.objectContaining({ asAgent: AGENT }), { chat: CHAT }, [file], undefined);
    expect(checkReadingsOf(CHECK)?.shown).toHaveLength(4);
  });

  it('the App’s own storage is its real one (owner 10-13): its data is written, its program runs as the agent’s call', async () => {
    expect(await call(CHECK, 'writeData', { path: 'journal.json', content: '{}' })).toEqual({ ok: true, value: undefined });
    expect(data.writeExtensionData).toHaveBeenCalledWith('/data/board', 'journal.json', '{}');
    expect(await call(CHECK, 'callProgram', { name: 'set_done', arguments: { id: 'a' } })).toMatchObject({ ok: true, value: { content: [{ text: 'done' }] } });
    // The call is the agent's (owner 10-14): from the agent and its own session, as its own tool call would be — not the
    // page's place.
    expect(programs.callFromPage).toHaveBeenCalledWith('board', { name: 'set_done', arguments: { id: 'a' }, from: { agent: `user:${AGENT}`, agentSession: 'session-agent' } });
    expect(checkReadingsOf(CHECK)).toBeNull();
    // Control: the group's page, as the person — no agent.
    await call(REAL, 'callProgram', { name: 'set_done', arguments: { id: 'a' } });
    expect(programs.callFromPage).toHaveBeenLastCalledWith('board', { name: 'set_done', arguments: { id: 'a' }, from: {} });
  });
});
