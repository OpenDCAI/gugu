import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 统筹 10-05 (画廊车道 §6): a page in a group heard its whole context again for every update of any member row — a read
 * mark, a pin, mute — and the host read the members again each time: 224 in 38 s in a 112-person group. Now only a change
 * of who is there reads and pushes (`rosterMoved`): someone left, or an id not among them came.
 */

const PAGE = 7;
const CHAT = '0b000000-0000-4000-8000-000000000001';
const A = '0a000000-0000-4000-8000-00000000000a';
const B = '0a000000-0000-4000-8000-00000000000b';
const C = '0a000000-0000-4000-8000-00000000000c';
const sent: { event: { type: string; context?: { chat?: { members: { id: string }[] } } } }[] = [];
// Who is in the chat as the database says now (the ids `chatMembersOf` answers), and how often it was asked.
const reads = vi.hoisted(() => ({ members: 0, now: ['0a000000-0000-4000-8000-00000000000a', '0a000000-0000-4000-8000-00000000000b'] }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: {
    fromId: (id: number) =>
      id === 7 ? { id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: (_channel: string, event: never) => sent.push({ event }) } : undefined,
  },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'workspace', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => ['files:read'], hasCapability: () => true, get: () => ({ manifest: { name: 'Workspace' } }) }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@main/core/extensions/app-files', () => ({
  resourceChatOf: async (chatId: string) => chatId,
  chatMembersOf: async () => {
    reads.members += 1;
    return reads.now.map((id) => ({ id: `user:${id}`, name: id.slice(-1), kind: 'human' }));
  },
  surfaceChatOf: async () => ({ id: '0b000000-0000-4000-8000-000000000001', name: 'G', kind: 'group', groupId: '0b000000-0000-4000-8000-000000000001' }),
}));

const { bindExtensionSurface, chatMembersChanged, pushContext, setExtensionBridgeHost, unbindExtensionSurface, updateExtensionSurfaceLayout } = await import('./extension-bridge');

const pushes = () => sent.filter(({ event }) => event.type === 'context').length;

const bind = async () => {
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'workspace', tabId: 'slot-1', tabKind: 'workspace.main', chatId: CHAT });
  updateExtensionSurfaceLayout(PAGE, { visible: true, width: 440, height: 700 });
  await vi.waitFor(() => expect(pushes()).toBeGreaterThan(0));
};

beforeEach(async () => {
  reads.now = [A, B];
  setExtensionBridgeHost({
    deliver: () => Promise.resolve(),
    presentation: () => ({ locale: 'en', themeMode: 'dark' as const, fullscreen: false, windowFocused: true }),
  });
  await bind();
  sent.length = 0;
  reads.members = 0;
});

// What moves who is there is `rosterMoved`'s own cells (app-files-chat-context); here, that the bridge goes by it.
describe('a member row of the chat changed (chat_members_changed)', () => {
  it('a read mark of someone already there: no read, no push; someone came: read again and the page told', async () => {
    await chatMembersChanged(CHAT, [{ memberId: A, left: false }, { memberId: B, left: false }]);
    expect([reads.members, pushes()]).toEqual([0, 0]);
    await chatMembersChanged(CHAT, [{ memberId: '0a000000-0000-4000-8000-00000000000c', left: false }]);
    expect([reads.members, pushes()]).toEqual([1, 1]);
  });
});

/**
 * 170 10-19 (mac1, both arms): an agent joined G while no App page was drawn for it; a page opened on G afterwards was told
 * the members from before, while `gugu.chats.members` in that same page read them as they are. With no page there, nobody
 * keeps a chat's members current: they are forgotten, and read afresh when a page is drawn for it again.
 */
describe('members that changed while no page was drawn for the chat', () => {
  it('a page drawn for it again is told who is there now', async () => {
    unbindExtensionSurface(PAGE);
    reads.now = [A, B, C];
    await chatMembersChanged(CHAT, [{ memberId: C, left: false }]);
    expect(reads.members).toBe(0);
    sent.length = 0;
    await bind();
    const told = sent.filter(({ event }) => event.type === 'context').at(-1)!.event.context!.chat!.members.map((member) => member.id);
    expect(told).toEqual([`user:${A}`, `user:${B}`, `user:${C}`]);
    expect(reads.members).toBe(1);
  });
});

/** A folder page opening asked who is in its chat three ways at once (bound, laid out, its own getContext): one read serves them. */
describe('a chat not read yet, asked about several times at once', () => {
  it('is read once', async () => {
    unbindExtensionSurface(PAGE);
    await chatMembersChanged(CHAT, [{ memberId: C, left: false }]);
    sent.length = 0;
    await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'workspace', tabId: 'slot-1', tabKind: 'workspace.main', chatId: CHAT });
    pushContext(PAGE);
    pushContext(PAGE);
    // Both asks answered: each push follows the read it waited on.
    await vi.waitFor(() => expect(pushes()).toBe(2), { timeout: 15_000 });
    expect(reads.members).toBe(1);
  });
});
