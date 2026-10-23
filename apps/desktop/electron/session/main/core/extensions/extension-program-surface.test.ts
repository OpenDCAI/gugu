import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Chats are named by their id (编号 18: placeOf refuses anything else).
const BOARD_CHAT = '0c4a7e10-0000-4000-8000-00000000b0a2';
const FOLDER_CHAT = '0c4a7e10-0000-4000-8000-00000000f01d';
const OTHER_CHAT = '0c4a7e10-0000-4000-8000-0000000000e2';
const TOPIC = '0c4a7e10-0000-4000-8000-0000000000e3';

/**
 * 摩擦单 F16 An App's program answered as a caller of its App: the frames `gugu-program.mjs` (L3) sends over the
 * child's IPC channel, answered by the bridge's one `answerCall`, as every page is (真源原则 13). A program sits
 * nowhere: a file is opened as the verb names it — one handed to the call the verb is made in (no capability; the frame
 * says which call), or any other with files:read — and what is a page's own (its tab, the person's gesture) is not a
 * program's.
 */

const granted = new Set<string>();
vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: () => undefined },
  shell: { openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'board', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null, runningExtensionBackgrounds: () => [] }));
vi.mock('@main/core/extensions/extension-programs', () => ({ extensionPrograms: {}, onExtensionProgramNotification: vi.fn() }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    hasCapability: (_id: string, wanted: string) => granted.has(wanted),
    grantedCapabilities: () => [...granted],
  }),
}));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: async () => null }));
const ports = new Map<number, { post: (data: unknown) => void }>();
const fileSync = {
  attachPort: vi.fn((id: number, extensionId: string, port: { post: (data: unknown) => void }) => {
    ports.set(id, port);
    return { id, extensionId };
  }),
  fromPort: vi.fn(),
  pageGone: vi.fn(),
  revoke: vi.fn(),
  openCount: vi.fn(() => 0),
};
vi.mock('./file-sync', () => ({ fileSync }));
const openAppFile = vi.fn(async () => ({ docName: 'd@1' }));
const listAppFiles = vi.fn(async () => []);
const uploadAppFiles = vi.fn(async () => [{ id: 'new-file' }]);
const renameAppFile = vi.fn(async () => ({ id: 'renamed' }));
const replaceAppFile = vi.fn(async () => ({ id: 'replaced', version: 2 }));
// #7257: the files a revision named, as the program reads them.
const changedGroupFiles = vi.fn(async (chatId: string, _reader: string | null, wanted: { ids: readonly string[]; all: boolean }) =>
  ({ entries: (wanted.all ? [] : wanted.ids).map((id) => ({ id, chat: chatId, name: 'board.json', version: 3 })), gone: [] }));
const chatsOf = vi.fn(async () => []);
const chatMembersOf = vi.fn(async () => []);
vi.mock('@main/core/extensions/app-files', () => ({
  resourceChatOf: async (chatId: string) => chatId === TOPIC ? FOLDER_CHAT : chatId,
  changedGroupFiles,
  chatsOf,
  chatMembersOf,
  openAppFile,
  reopenAppFile: vi.fn(),
  closeAppFile: vi.fn(),
  listAppFiles,
  uploadAppFiles,
  renameAppFile,
  replaceAppFile,
}));
// This computer's projects: one of the person's, and the hidden home folder sessions start in with no project chosen.
vi.mock('@main/core/projects/operations/getProjects', () => ({
  getProjects: async () => [
    { id: 'project-1', name: 'gugu', path: '/repo/gugu' },
    { id: '00000000-0000-4000-8000-000000000001', name: '任务工作区', path: '/home/.gugu/tasks' },
  ],
}));
const sendFromApp = vi.fn(async () => ({ id: 'm-1' }));
const messageAgentFromApp = vi.fn(async () => ({ id: 'm-2' }));
const messagesHistory = vi.fn(async () => ({ messages: [], next: null }));
vi.mock('@main/core/extensions/extension-send', () => ({ sendFromApp, messageAgentFromApp, messagesForApp: { history: messagesHistory, search: vi.fn() } }));

const { attachProgramSurface } = await import('./extension-program-surface');
const { notifyGroupWorkspaceChanged, setExtensionBridgeHost } = await import('./extension-bridge');
const { APP_FRAME_MARKER } = await import('@shared/extensions/app-runtime-protocol');

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { connected: true, sent: [] as unknown[] });
  (child as unknown as { send: (message: unknown) => boolean }).send = (message) => (child.sent.push(message), true);
  return child;
}
/** One verb over the channel (made in tool call `inCall`, when given), and its answer once the bridge gave one. */
async function call(child: ReturnType<typeof fakeChild>, id: number, method: string, args: unknown, inCall?: string) {
  child.emit('message', { m: APP_FRAME_MARKER, t: 'call', id, method, args, ...(inCall ? { call: inCall } : {}) });
  return vi.waitFor(() => {
    const answer = child.sent.find((frame) => (frame as { id?: number }).id === id);
    if (!answer) throw new Error(`no answer to ${method} yet`);
    return answer;
  });
}

const HANDED = { itemId: 'item-board', chatId: BOARD_CHAT, agentUserId: 'agent-1' };

beforeEach(() => {
  granted.clear();
  ports.clear();
  vi.clearAllMocks();
});

describe('an App program as a caller of its App (F16)', () => {
  it('each later watch keeps its own caller after an owner watch, including repeated calls at the same topic', async () => {
    granted.add('files:read');
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    expect(await call(child, 850, 'filesWatch', { place: { chat: BOARD_CHAT } })).toMatchObject({ ok: true });
    for (const [index, agent] of ['agent-1', 'agent-2', 'agent-3'].entries()) {
      const callId = `watch-call-${index}`;
      const release = surface.hand(callId, agent, [], [{ chatId: TOPIC, resourceChatId: FOLDER_CHAT, agentUserId: agent }]);
      expect(await call(child, 851 + index * 2, 'filesWatch', { place: { chat: TOPIC } }, callId)).toMatchObject({ ok: true });
      expect(await call(child, 852 + index * 2, 'filesWatch', { place: { chat: OTHER_CHAT } }, callId)).toMatchObject({ ok: false, code: 'denied' });
      changedGroupFiles.mockClear();
      const item = `agent-file-${index}`;
      await notifyGroupWorkspaceChanged([
        { chatId: BOARD_CHAT, itemIds: ['owner-file'] },
        { chatId: FOLDER_CHAT, itemIds: [item] },
        { chatId: OTHER_CHAT, itemIds: ['not-handed'] },
      ]);
      expect(changedGroupFiles.mock.calls.map(([chat, reader]) => [chat, reader])).toEqual([[BOARD_CHAT, null], [FOLDER_CHAT, agent]]);
      expect(child.sent).toContainEqual(expect.objectContaining({
        t: 'event', event: expect.objectContaining({ place: { chat: TOPIC }, change: expect.objectContaining({ entries: [expect.objectContaining({ id: item, chat: FOLDER_CHAT })] }) }),
      }));
      await release();
      changedGroupFiles.mockClear();
      await notifyGroupWorkspaceChanged([{ chatId: FOLDER_CHAT, itemIds: ['after-release'] }]);
      expect(changedGroupFiles).not.toHaveBeenCalled();
    }
    surface.close();
  });

  it('a handed topic grants its source files while message history keeps the topic address', async () => {
    granted.add('files:read');
    granted.add('chat:read');
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    const release = surface.hand('topic-call', 'agent-1', [], [{ chatId: TOPIC, resourceChatId: FOLDER_CHAT, agentUserId: 'agent-1' }]);
    const page = { pageId: surface.pageId, extensionId: 'board', handed: null, asAgent: 'agent-1' };
    expect(await call(child, 801, 'filesList', { place: { chat: TOPIC } }, 'topic-call')).toMatchObject({ ok: true });
    expect(listAppFiles).toHaveBeenLastCalledWith(page, { place: { chat: TOPIC } });
    expect(await call(child, 802, 'filesOpen', { ref: { chat: FOLDER_CHAT, id: 'source-file' } }, 'topic-call')).toMatchObject({ ok: true });
    expect(openAppFile).toHaveBeenLastCalledWith(page, { ref: { chat: FOLDER_CHAT, id: 'source-file' } });
    expect(await call(child, 803, 'messagesHistory', { chat: TOPIC }, 'topic-call')).toMatchObject({ ok: true });
    expect(messagesHistory).toHaveBeenLastCalledWith({ chat: TOPIC }, { asAgent: 'agent-1' });
    expect(await call(child, 804, 'messagesHistory', { chat: FOLDER_CHAT }, 'topic-call')).toMatchObject({ ok: false, code: 'denied' });
    expect(await call(child, 805, 'filesList', { place: { chat: OTHER_CHAT } }, 'topic-call')).toMatchObject({ ok: false, code: 'denied' });
    expect(await call(child, 806, 'filesWatch', { place: { chat: TOPIC } }, 'topic-call')).toMatchObject({ ok: true });
    await notifyGroupWorkspaceChanged([{ chatId: FOLDER_CHAT, itemIds: ['source-file'] }]);
    expect(changedGroupFiles).toHaveBeenLastCalledWith(FOLDER_CHAT, 'agent-1', { ids: ['source-file'], all: false });
    await release();
    changedGroupFiles.mockClear();
    await notifyGroupWorkspaceChanged([{ chatId: FOLDER_CHAT, itemIds: ['source-file'] }]);
    expect(changedGroupFiles).not.toHaveBeenCalled();
    surface.close();
  });

  it('opens the file a call handed it with no capability, in that file\'s group, on its own relay page', async () => {
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    expect(surface.pageId).toBeLessThan(0);
    const release = surface.hand('call-1', 'agent-1', [HANDED]);
    const result = await call(child, 1, 'filesOpen', { ref: { id: 'item-board' } }, 'call-1');
    expect(result).toEqual({ m: APP_FRAME_MARKER, t: 'result', id: 1, ok: true, value: { docName: 'd@1' } });
    expect(openAppFile).toHaveBeenCalledWith(
      { pageId: surface.pageId, extensionId: 'board', handed: { chat: BOARD_CHAT, id: 'item-board' }, asAgent: 'agent-1' },
      { ref: { id: 'item-board' } },
    );
    // The call ends: what was opened on being handed alone goes with it.
    await release();
    expect(fileSync.revoke).toHaveBeenCalledWith(surface.pageId, 'unbound', expect.any(Function));
    const which = fileSync.revoke.mock.calls[0]![2] as (grant: { itemId: string; needs: string | null; asAgent?: string }) => boolean;
    expect(which({ itemId: 'item-board', needs: null, asAgent: 'agent-1' })).toBe(true);
    expect(which({ itemId: 'item-board', needs: 'files:read' }), 'one the App\'s own page opened with a capability stays').toBe(false);
    expect(which({ itemId: 'other', needs: null, asAgent: 'agent-1' })).toBe(false);
  });

  it('a call ends once the program let go of the file it was handed — its last writes handed on first (F106)', async () => {
    const surface = attachProgramSurface('board', fakeChild() as unknown as ChildProcess);
    const release = surface.hand('call-1', 'agent-1', [HANDED]);
    let letGo!: () => void;
    fileSync.revoke.mockReturnValueOnce(new Promise<void>((resolve) => (letGo = resolve)));
    let ended = false;
    const ending = release().then(() => (ended = true));
    await vi.waitFor(() => expect(fileSync.revoke).toHaveBeenCalledWith(surface.pageId, 'unbound', expect.any(Function)));
    expect(ended, 'not before the program closed it').toBe(false);
    letGo();
    await ending;
    expect(ended).toBe(true);
  });

  it('a file handed by two calls of one agent stays handed until both end', async () => {
    const surface = attachProgramSurface('board', fakeChild() as unknown as ChildProcess);
    const first = surface.hand('call-1', 'agent-1', [HANDED]);
    const second = surface.hand('call-2', 'agent-1', [HANDED]);
    await first();
    expect(fileSync.revoke).not.toHaveBeenCalled();
    await second();
    expect(fileSync.revoke).toHaveBeenCalledTimes(1);
  });

  // One program serves every session here: two agents' calls may hand it one file at once (play4 10-13: Codex's edit,
  // 42 ms after Claude's read of the same deck, was saved as Claude's). Each verb says its own call: never a guess.
  it('one file handed by two agents\' calls at once: each verb is its own call\'s agent — no guess, nothing refused', async () => {
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    const first = surface.hand('call-a', 'agent-1', [HANDED]);
    const second = surface.hand('call-b', 'agent-2', [{ ...HANDED, agentUserId: 'agent-2' }]);
    const asAgent = (agent: string) => ({ pageId: surface.pageId, extensionId: 'board', handed: { chat: BOARD_CHAT, id: 'item-board' }, asAgent: agent });
    expect(await call(child, 40, 'filesOpen', { ref: { id: 'item-board' } }, 'call-b')).toMatchObject({ ok: true });
    expect(openAppFile).toHaveBeenLastCalledWith(asAgent('agent-2'), { ref: { id: 'item-board' } });
    expect(await call(child, 41, 'filesOpen', { ref: { id: 'item-board' } }, 'call-a')).toMatchObject({ ok: true });
    expect(openAppFile).toHaveBeenLastCalledWith(asAgent('agent-1'), { ref: { id: 'item-board' } });
    await first();
    // The first agent's call is over: only what was opened as it goes; the second agent's call keeps its own.
    const which = fileSync.revoke.mock.calls[0]![2] as (grant: { itemId: string; needs: string | null; asAgent?: string }) => boolean;
    expect(which({ itemId: 'item-board', needs: null, asAgent: 'agent-1' })).toBe(true);
    expect(which({ itemId: 'item-board', needs: null, asAgent: 'agent-2' })).toBe(false);
    expect(await call(child, 42, 'filesOpen', { ref: { id: 'item-board' } }, 'call-b')).toMatchObject({ ok: true });
    expect(openAppFile).toHaveBeenLastCalledWith(asAgent('agent-2'), { ref: { id: 'item-board' } });
    // A call that is over hands nothing any more: a verb still naming it is refused, never done as the person (170 10-19).
    expect(await call(child, 43, 'filesOpen', { ref: { id: 'item-board' } }, 'call-a')).toMatchObject({ ok: false, code: 'denied' });
    expect(openAppFile).toHaveBeenCalledTimes(3);
    await second();
  });

  it('a verb made in no call (a timer, a file\'s change) is the App\'s own page\'s, even while a call hands that file', async () => {
    granted.add('files:read');
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    const release = surface.hand('call-1', 'agent-1', [HANDED], [{ chatId: FOLDER_CHAT, resourceChatId: FOLDER_CHAT, agentUserId: 'agent-1' }]);
    const asPage = { pageId: surface.pageId, extensionId: 'board', handed: null };
    await call(child, 44, 'filesOpen', { ref: { id: 'item-board' } });
    expect(openAppFile).toHaveBeenLastCalledWith(asPage, { ref: { id: 'item-board' } });
    await call(child, 45, 'filesList', { place: { chat: FOLDER_CHAT } });
    expect(listAppFiles).toHaveBeenLastCalledWith(asPage, { place: { chat: FOLDER_CHAT } });
    await release();
  });

  // gugu.messages: an agent's call reads what that agent reads — a chat it handed; any other is refused, never read as the
  // person (170 10-19). Outside any call (a timer), and a person's page calling the program: as the person, by chat:read.
  it('messages: an agent\'s call reads a chat it handed as that agent, refuses one it did not; no call reads as the person; a working copy is not refused', async () => {
    granted.add('chat:read');
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    const release = surface.hand('call-1', 'agent-1', [], [{ chatId: FOLDER_CHAT, resourceChatId: FOLDER_CHAT, agentUserId: 'agent-1' }]);
    expect(await call(child, 50, 'messagesHistory', { chat: FOLDER_CHAT }, 'call-1')).toMatchObject({ ok: true });
    expect(messagesHistory).toHaveBeenLastCalledWith({ chat: FOLDER_CHAT }, { asAgent: 'agent-1' });
    expect(await call(child, 51, 'messagesHistory', { chat: OTHER_CHAT }, 'call-1')).toMatchObject({ ok: false, code: 'denied' });
    // An agent's call that handed nothing at all is still an agent's call.
    expect(await call(child, 52, 'messagesHistory', { chat: OTHER_CHAT }, 'call-2')).toMatchObject({ ok: false, code: 'denied' });
    expect(messagesHistory).toHaveBeenCalledTimes(1);
    expect(await call(child, 53, 'messagesHistory', { chat: OTHER_CHAT })).toMatchObject({ ok: true });
    expect(messagesHistory).toHaveBeenLastCalledWith({ chat: OTHER_CHAT }, { asAgent: null });
    // A session's working copy is no chat's: in an agent's call it stays the capability's, never refused here.
    const local = { ref: { session: 'session-1', name: 'notes.md' } };
    expect(await call(child, 54, 'filesOpen', local, 'call-1')).toMatchObject({ ok: true });
    expect(openAppFile).toHaveBeenLastCalledWith({ pageId: surface.pageId, extensionId: 'board', handed: null }, local);
    // So is a project's folder (L1, 170 10-19): no membership to check a folder against — the capability's, as a session's.
    const project = { ref: { project: 'project-1', name: 'docs/plan.md' } };
    expect(await call(child, 55, 'filesOpen', project, 'call-2')).toMatchObject({ ok: true });
    expect(openAppFile).toHaveBeenLastCalledWith({ pageId: surface.pageId, extensionId: 'board', handed: null }, project);
    await release();
  });

  // L1 gugu.projects.list(): this computer's projects, each one's folder a place — by files:read, the hidden home not one.
  it('projects: listed by id and name with files:read — no path, not the hidden home folder; without it, denied', async () => {
    const child = fakeChild();
    attachProgramSurface('board', child as unknown as ChildProcess);
    expect(await call(child, 70, 'projectsList', {})).toMatchObject({ ok: false, code: 'denied' });
    granted.add('files:read');
    expect(await call(child, 71, 'projectsList', {}, 'call-1')).toEqual(expect.objectContaining({ ok: true, value: { projects: [{ id: 'project-1', name: 'gugu' }] } }));
  });

  // gugu.chats: an agent's call lists its own agent's chats, and reads the members of a chat it handed (or a handed
  // file's) as that agent; any other chat is refused. A call gugu knows no agent of lists nothing. No call: the person.
  it('chats: an agent\'s call lists as its agent, even one that handed nothing; members only of what it handed', async () => {
    granted.add('chat:read');
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    const handing = surface.hand('call-1', 'agent-1', [HANDED], [{ chatId: FOLDER_CHAT, resourceChatId: FOLDER_CHAT, agentUserId: 'agent-1' }]);
    const bare = surface.hand('call-2', 'agent-2', []);
    const nobody = surface.hand('call-3', null, []);
    expect(await call(child, 60, 'chatsList', {}, 'call-1')).toEqual(expect.objectContaining({ ok: true, value: { chats: [] } }));
    expect(chatsOf).toHaveBeenLastCalledWith({ asAgent: 'agent-1' });
    expect(await call(child, 61, 'chatsList', {}, 'call-2')).toMatchObject({ ok: true });
    expect(chatsOf).toHaveBeenLastCalledWith({ asAgent: 'agent-2' });
    expect(await call(child, 62, 'chatsList', {}, 'call-3')).toMatchObject({ ok: false, code: 'denied' });
    expect(await call(child, 63, 'chatsList', {})).toMatchObject({ ok: true });
    expect(chatsOf).toHaveBeenLastCalledWith({ asAgent: null });
    expect(chatsOf).toHaveBeenCalledTimes(3);

    expect(await call(child, 64, 'chatsMembers', { chat: FOLDER_CHAT }, 'call-1')).toMatchObject({ ok: true, value: { members: [] } });
    expect(chatMembersOf).toHaveBeenLastCalledWith(FOLDER_CHAT, { asAgent: 'agent-1' });
    // The chat of a file it handed (G5), named in capitals: the same chat.
    expect(await call(child, 65, 'chatsMembers', { chat: BOARD_CHAT.toUpperCase() }, 'call-1')).toMatchObject({ ok: true });
    expect(chatMembersOf).toHaveBeenLastCalledWith(BOARD_CHAT, { asAgent: 'agent-1' });
    expect(await call(child, 66, 'chatsMembers', { chat: OTHER_CHAT }, 'call-1')).toMatchObject({ ok: false, code: 'denied' });
    expect(await call(child, 67, 'chatsMembers', { chat: OTHER_CHAT }, 'call-2')).toMatchObject({ ok: false, code: 'denied' });
    expect(await call(child, 68, 'chatsMembers', { chat: '209882' }, 'call-1')).toMatchObject({ ok: false, code: 'invalid' });
    expect(chatMembersOf).toHaveBeenCalledTimes(2);
    expect(await call(child, 69, 'chatsMembers', { chat: OTHER_CHAT })).toMatchObject({ ok: true });
    expect(chatMembersOf).toHaveBeenLastCalledWith(OTHER_CHAT, { asAgent: null });
    // Without chat:read none of it.
    granted.clear();
    expect(await call(child, 70, 'chatsList', {})).toMatchObject({ ok: false, code: 'denied' });
    await Promise.all([handing(), bare(), nobody()]);
  });

  it('a verb made in no call, any other file: not handed — the files code then asks for files:read as for a page', async () => {
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    await call(child, 2, 'filesOpen', { ref: { id: 'item-x' } });
    expect(openAppFile).toHaveBeenCalledWith({ pageId: surface.pageId, extensionId: 'board', handed: null }, { ref: { id: 'item-x' } });
  });

  // Control (the parent commit a770f2e40d): a program had its own list of verbs, and refused the rest as `denied`.
  it('the same door as a page: the capability first; what is a page\'s own is invalid — a program has none', async () => {
    const child = fakeChild();
    attachProgramSurface('board', child as unknown as ChildProcess);
    // A name says nothing of where: refused, said how (真源原则 13).
    expect(await call(child, 3, 'filesOpen', { ref: { name: 'board.json' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call(child, 4, 'filesList', { place: { chat: BOARD_CHAT } })).toMatchObject({ ok: false, code: 'denied' });
    granted.add('files:read');
    expect(await call(child, 10, 'filesList', { place: { chat: BOARD_CHAT } })).toMatchObject({ ok: true, value: [] });
    expect(listAppFiles).toHaveBeenCalledWith(expect.objectContaining({ handed: null }), { place: { chat: BOARD_CHAT } });
    expect(await call(child, 6, 'clipboardWriteText', { text: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
  });

  // Control (the parent commit 30d127962): `filesUpload` was a page's own — a program could not put a file it made in a chat.
  it('G5: a program uploads the bytes it has (files:write at the door); it never opens the person\'s picker', async () => {
    const child = fakeChild();
    attachProgramSurface('board', child as unknown as ChildProcess);
    const files = [{ name: 'deck.pptx', contentType: 'application/octet-stream', bytes: new ArrayBuffer(2) }];
    expect(await call(child, 20, 'filesUpload', { place: { chat: BOARD_CHAT }, files })).toMatchObject({ ok: false, code: 'denied' });
    granted.add('files:write');
    expect(await call(child, 21, 'filesUpload', { place: { chat: BOARD_CHAT }, files })).toMatchObject({ ok: true, value: [{ id: 'new-file' }] });
    expect(uploadAppFiles).toHaveBeenCalledWith(expect.objectContaining({ handed: null }), { chat: BOARD_CHAT }, files, undefined);
    expect(await call(child, 22, 'filesUpload', { place: { chat: BOARD_CHAT }, pick: true })).toMatchObject({
      ok: false,
      code: 'invalid',
      message: expect.stringMatching(/a program uploads the bytes it has; only a page opens the picker/),
    });
    expect(uploadAppFiles).toHaveBeenCalledTimes(1);
  });

  it('G5: into the chat of a file an agent handed it, the program uploads as that agent; any other chat is refused', async () => {
    granted.add('files:write');
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    const release = surface.hand('call-1', 'agent-1', [HANDED]);
    const files = [{ name: 'deck.pptx', contentType: 'application/octet-stream', bytes: new ArrayBuffer(2) }];
    expect(await call(child, 30, 'filesUpload', { place: { chat: BOARD_CHAT }, files }, 'call-1')).toMatchObject({ ok: true });
    expect(uploadAppFiles).toHaveBeenLastCalledWith(expect.objectContaining({ handed: null, asAgent: 'agent-1' }), { chat: BOARD_CHAT }, files, undefined);
    // An agent's call works only as that agent (170 10-19): another chat is refused, never uploaded as the person.
    expect(await call(child, 31, 'filesUpload', { place: { chat: OTHER_CHAT }, files }, 'call-1')).toMatchObject({ ok: false, code: 'denied' });
    await release();
    // The call is over: a verb still naming it (a timer it set) is refused too.
    expect(await call(child, 32, 'filesUpload', { place: { chat: BOARD_CHAT }, files }, 'call-1')).toMatchObject({ ok: false, code: 'denied' });
    expect(uploadAppFiles).toHaveBeenCalledTimes(1);
    // Made in no call: the App's own, as the person by files:write.
    expect(await call(child, 33, 'filesUpload', { place: { chat: BOARD_CHAT }, files })).toMatchObject({ ok: true });
    expect(uploadAppFiles).toHaveBeenLastCalledWith({ pageId: surface.pageId, extensionId: 'board', handed: null }, { chat: BOARD_CHAT }, files, undefined);
  });

  it('A1: in a chat a call handed it, what the program lists, uploads and renames is the agent\'s — until that call ends', async () => {
    granted.add('files:read');
    granted.add('files:write');
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    const release = surface.hand('call-1', 'agent-1', [], [{ chatId: FOLDER_CHAT, resourceChatId: FOLDER_CHAT, agentUserId: 'agent-1' }]);
    const asAgent = { pageId: surface.pageId, extensionId: 'board', handed: null, asAgent: 'agent-1' };
    const asPerson = { pageId: surface.pageId, extensionId: 'board', handed: null };
    expect(await call(child, 50, 'filesList', { place: { chat: FOLDER_CHAT } }, 'call-1')).toMatchObject({ ok: true });
    expect(listAppFiles).toHaveBeenLastCalledWith(asAgent, { place: { chat: FOLDER_CHAT } });
    const files = [{ name: 'notes.md', contentType: 'text/markdown', bytes: new ArrayBuffer(2) }];
    const from = ['55555555-5555-4555-8555-555555555555'];
    expect(await call(child, 51, 'filesUpload', { place: { chat: FOLDER_CHAT }, files, sourceMessageIds: from }, 'call-1')).toMatchObject({ ok: true });
    expect(uploadAppFiles).toHaveBeenLastCalledWith(asAgent, { chat: FOLDER_CHAT }, files, from);
    // A file named in that chat, by its name: the agent's too.
    const rename = { ref: { chat: FOLDER_CHAT, name: 'notes.md' }, name: 'plan.md' };
    expect(await call(child, 52, 'filesRename', rename, 'call-1')).toMatchObject({ ok: true });
    expect(renameAppFile).toHaveBeenLastCalledWith(asAgent, rename);
    // Another chat: refused — an agent's call is never the person's (170 10-19).
    expect(await call(child, 53, 'filesList', { place: { chat: OTHER_CHAT } }, 'call-1')).toMatchObject({ ok: false, code: 'denied' });
    // Across every chat (search): no chat was handed for it, refused too.
    expect(await call(child, 55, 'filesSearch', { query: 'notes' }, 'call-1')).toMatchObject({ ok: false, code: 'denied' });
    await release();
    expect(await call(child, 54, 'filesList', { place: { chat: FOLDER_CHAT } }, 'call-1')).toMatchObject({ ok: false, code: 'denied' });
    expect(await call(child, 56, 'filesList', { place: { chat: FOLDER_CHAT } })).toMatchObject({ ok: true });
    expect(listAppFiles).toHaveBeenLastCalledWith(asPerson, { place: { chat: FOLDER_CHAT } });
  });

  // 评审 P4 (10-13): a file opened by the capability words in a chat the call handed it (A1) was left open as the agent
  // when the call ended — the program could go on writing as the agent, in a chat the person may not be in.
  it('A1/G5: what the program opened as the agent by the capability words goes when the call ends; a write naming that call after is refused', async () => {
    granted.add('files:write');
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    const release = surface.hand('call-1', 'agent-1', [], [{ chatId: FOLDER_CHAT, resourceChatId: FOLDER_CHAT, agentUserId: 'agent-1' }]);
    const ref = { ref: { chat: FOLDER_CHAT, id: 'item-notes' } };
    expect(await call(child, 70, 'filesOpen', ref, 'call-1')).toMatchObject({ ok: true });
    expect(openAppFile).toHaveBeenLastCalledWith({ pageId: surface.pageId, extensionId: 'board', handed: null, asAgent: 'agent-1' }, ref);
    await release();
    expect(fileSync.revoke).toHaveBeenCalledTimes(1);
    const which = fileSync.revoke.mock.calls[0]![2] as (grant: { itemId: string; needs: string | null; asAgent?: string }) => boolean;
    expect(which({ itemId: 'item-notes', needs: 'files:write', asAgent: 'agent-1' })).toBe(true);
    expect(which({ itemId: 'item-notes', needs: 'files:write' }), 'what the App\'s own page opened stays').toBe(false);
    expect(which({ itemId: 'item-notes', needs: 'files:write', asAgent: 'agent-2' }), 'another agent\'s stays').toBe(false);
    // The program writes to it after the call, naming the call it was opened in (a timer): refused, never the person's write.
    const replace = { ...ref, file: { name: '', contentType: 'text/markdown', bytes: new ArrayBuffer(2) } };
    expect(await call(child, 71, 'filesReplace', replace, 'call-1')).toMatchObject({ ok: false, code: 'denied' });
    expect(replaceAppFile).not.toHaveBeenCalled();
    // In no call: the App's own page, by files:write.
    expect(await call(child, 72, 'filesReplace', replace)).toMatchObject({ ok: true });
    expect(replaceAppFile).toHaveBeenLastCalledWith({ pageId: surface.pageId, extensionId: 'board', handed: null }, replace);
  });

  it('what an agent opened by the capability words stays while another call of that agent runs, and goes when the last one ends', async () => {
    const surface = attachProgramSurface('board', fakeChild() as unknown as ChildProcess);
    const first = surface.hand('call-1', 'agent-1', [], [{ chatId: FOLDER_CHAT, resourceChatId: FOLDER_CHAT, agentUserId: 'agent-1' }]);
    const second = surface.hand('call-2', 'agent-1', [], [{ chatId: OTHER_CHAT, resourceChatId: OTHER_CHAT, agentUserId: 'agent-1' }]);
    await first();
    expect(fileSync.revoke).not.toHaveBeenCalled();
    await second();
    expect(fileSync.revoke).toHaveBeenCalledTimes(1);
    const which = fileSync.revoke.mock.calls[0]![2] as (grant: { itemId: string; needs: string | null; asAgent?: string }) => boolean;
    expect(which({ itemId: 'item-notes', needs: 'files:write', asAgent: 'agent-1' })).toBe(true);
  });

  it('A1 + G5: one chat in two agents\' calls at once (handed, or the chat of a handed file) — each verb is its own call\'s agent', async () => {
    granted.add('files:read');
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    const first = surface.hand('call-a', 'agent-1', [], [{ chatId: FOLDER_CHAT, resourceChatId: FOLDER_CHAT, agentUserId: 'agent-1' }]);
    const second = surface.hand('call-b', 'agent-2', [{ itemId: 'item-folder', chatId: FOLDER_CHAT, agentUserId: 'agent-2' }]);
    const asAgent = (agent: string) => ({ pageId: surface.pageId, extensionId: 'board', handed: null, asAgent: agent });
    expect(await call(child, 60, 'filesList', { place: { chat: FOLDER_CHAT } }, 'call-b')).toMatchObject({ ok: true });
    expect(listAppFiles).toHaveBeenLastCalledWith(asAgent('agent-2'), { place: { chat: FOLDER_CHAT } });
    expect(await call(child, 61, 'filesList', { place: { chat: FOLDER_CHAT } }, 'call-a')).toMatchObject({ ok: true });
    expect(listAppFiles).toHaveBeenLastCalledWith(asAgent('agent-1'), { place: { chat: FOLDER_CHAT } });
    await first();
    await second();
  });

  it('getContext: who it is for, never where — no tab, no session, no chat', async () => {
    setExtensionBridgeHost({ deliver: async () => undefined, presentation: () => ({ locale: 'zh-CN', themeMode: 'dark', fullscreen: false, windowFocused: true }) });
    granted.add('files:read');
    const child = fakeChild();
    attachProgramSurface('board', child as unknown as ChildProcess);
    expect(await call(child, 11, 'getContext', {})).toMatchObject({
      ok: true,
      value: { apiVersion: expect.any(Number), locale: 'zh-CN', themeMode: 'dark', capabilities: ['files:read'] },
    });
  });

  it('send whispers in the chat of the file it is about (chat:relay at the door); messageAgent tells one of the person\'s agents', async () => {
    const child = fakeChild();
    attachProgramSurface('board', child as unknown as ChildProcess);
    const args = { to: 'user:a', text: 'card 17 was marked doubtful', refs: [{ file: { id: 'item-board' } }] };
    expect(await call(child, 7, 'send', args)).toMatchObject({ ok: false, code: 'denied' });
    granted.add('chat:relay');
    expect(await call(child, 8, 'send', args)).toMatchObject({ ok: true, value: { id: 'm-1' } });
    expect(sendFromApp).toHaveBeenCalledWith('board', args, {});
    granted.add('agents:control');
    expect(await call(child, 9, 'messageAgent', { agentId: 'user:a', text: 'run it' })).toMatchObject({ ok: true, value: { id: 'm-2' } });
    expect(messageAgentFromApp).toHaveBeenCalledWith('board', { agentId: 'user:a', text: 'run it' }, {});
  });

  // Control (the parent commit a770f2e40d): `files.onChanged` was on a program's gugu and never fired.
  it('files.onChanged: a place it watches tells it, on its channel', async () => {
    granted.add('files:read');
    const child = fakeChild();
    attachProgramSurface('board', child as unknown as ChildProcess);
    expect(await call(child, 12, 'filesWatch', { place: { chat: BOARD_CHAT }, on: true })).toMatchObject({ ok: true });
    await notifyGroupWorkspaceChanged([{ chatId: BOARD_CHAT, itemIds: ['board-1'] }]);
    expect(child.sent).toContainEqual({
      m: APP_FRAME_MARKER,
      t: 'event',
      event: { type: 'filesChanged', place: { chat: BOARD_CHAT }, change: { kind: 'entries', entries: [{ id: 'board-1', chat: BOARD_CHAT, name: 'board.json', version: 3 }], gone: [] } },
    });
  });

  it('file sync frames go both ways on the IPC channel, as a page\'s port carries them', () => {
    const child = fakeChild();
    const surface = attachProgramSurface('board', child as unknown as ChildProcess);
    const bytes = new Uint8Array([1, 2, 3]);
    child.emit('message', { m: APP_FRAME_MARKER, t: 'sync', data: bytes });
    expect(fileSync.fromPort).toHaveBeenCalledWith({ id: surface.pageId, extensionId: 'board' }, bytes);
    ports.get(surface.pageId)!.post({ t: 'granted' });
    expect(child.sent).toEqual([{ m: APP_FRAME_MARKER, t: 'sync', data: { t: 'granted' } }]);
    surface.close();
    expect(fileSync.pageGone).toHaveBeenCalledWith(surface.pageId);
    child.emit('message', { m: APP_FRAME_MARKER, t: 'sync', data: bytes });
    expect(fileSync.fromPort).toHaveBeenCalledTimes(1);
  });
});
