import { beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';

/**
 * #7257: a chat's files changing reach the pages that asked about that chat (`files.onChanged({ chat }, fn)`) as those
 * files — `{ kind: 'entries', entries, gone }`, read once per chat and reader (the person, or the agent a page works as),
 * never a `resync` that has each page list the chat again. While a read is on its way, the ids named meanwhile wait for
 * it and go in exactly one more read. The read itself (`changedGroupFiles`) is a fake; what it was asked is recorded.
 */

const PERSON_PAGE = 7;
const AGENT_PAGE = 8;
const OTHER_PAGE = 9;
const CHAT = '0b000000-0000-4000-8000-000000000001';
const OTHER_CHAT = '0b000000-0000-4000-8000-000000000002';
const TOPIC = '0b000000-0000-4000-8000-000000000003';
const AGENT = '0a000000-0000-4000-8000-0000000000a1';
const [A, B, C] = ['0f000000-0000-4000-8000-00000000000a', '0f000000-0000-4000-8000-00000000000b', '0f000000-0000-4000-8000-00000000000c'];
const sent: { id: number; event: { type: string; change?: unknown } }[] = [];
const contentsOf = (id: number) => ({
  id,
  isDestroyed: () => false,
  hostWebContents: { id: 42 },
  session: { id },
  once: () => undefined,
  on: () => undefined,
  send: (_channel: string, event: { type: string }) => sent.push({ id, event }),
});
const handlers = vi.hoisted(() => new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>());
/** Each read asked of the fake, a way to hold it open until the test lets it answer, and one reader's reads to fail. */
const reads = vi.hoisted(() => ({
  asked: [] as { chatId: string; reader: string | null; ids: readonly string[]; all: boolean }[],
  hold: null as Promise<void> | null,
  failFor: null as { reader: string | null; times: number } | null,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn), on: vi.fn() },
  webContents: { fromId: (id: number) => ([PERSON_PAGE, AGENT_PAGE, OTHER_PAGE].includes(id) ? contentsOf(id) : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'workspace', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => ['files:read'], hasCapability: () => true, get: () => ({ manifest: { name: 'Workspace' } }) }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@main/core/extensions/app-files', () => ({
  resourceChatOf: async (chatId: string) => chatId === TOPIC ? CHAT : chatId,
  changedGroupFiles: async (chatId: string, reader: string | null, wanted: { ids: readonly string[]; all: boolean }) => {
    reads.asked.push({ chatId, reader, ids: [...wanted.ids].sort(), all: wanted.all });
    if (reads.hold) await reads.hold;
    if (reads.failFor && reads.failFor.reader === reader && reads.failFor.times > 0) {
      reads.failFor.times -= 1;
      throw new Error('offline');
    }
    // Every file of the chat: A. What the reader sees: the agent does not see B.
    const named = wanted.all ? [A] : wanted.ids;
    const seen = named.filter((id) => !(reader === AGENT && id === B));
    const gone = (wanted.all ? wanted.ids : named).filter((id) => !seen.includes(id));
    return { entries: seen.map((id) => ({ id, chat: chatId, name: `${id.slice(-1)}.md`, version: 2 })), gone };
  },
}));

const { bindExtensionSurface, notifyGroupWorkspaceChanged, notifyInstalledAppsChanged, registerExtensionBridge, stopPageWatches } = await import('./extension-bridge');
const { MAX_HELD_IDS } = await import('@shared/extensions/coalesced-reads');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const watch = (id: number, place: unknown, on = true) =>
  handlers.get(EXTENSION_BRIDGE_CHANNEL)!({ sender: contentsOf(id) }, { method: 'filesWatch', args: { watchId: JSON.stringify(place), place, on } });
const changesTo = (id: number) => sent.filter((s) => s.id === id && s.event.type === 'filesChanged').map((s) => s.event.change);

beforeEach(async () => {
  for (const id of [PERSON_PAGE, AGENT_PAGE, OTHER_PAGE]) stopPageWatches(id);
  sent.length = 0;
  reads.asked.length = 0;
  reads.hold = null;
  reads.failFor = null;
  await bindExtensionSurface({ webContentsId: PERSON_PAGE, extensionId: 'workspace', tabId: 'slot-1', tabKind: 'workspace.main', conversation: CHAT });
  await bindExtensionSurface({
    webContentsId: AGENT_PAGE, extensionId: 'workspace', tabId: 'check-1', tabKind: 'workspace.main', conversation: CHAT,
    operator: { kind: 'agent', id: `user:${AGENT}` },
  });
  await bindExtensionSurface({ webContentsId: OTHER_PAGE, extensionId: 'workspace', tabId: 'slot-2', tabKind: 'workspace.main', conversation: OTHER_CHAT });
  for (const [id, chat] of [[PERSON_PAGE, CHAT], [AGENT_PAGE, CHAT], [OTHER_PAGE, OTHER_CHAT]] as const) {
    expect(await watch(id, { chat })).toMatchObject({ ok: true });
  }
  sent.length = 0;
});

describe('a chat\'s files changed: its pages hear those files (#7257)', () => {
  it('a topic and source subscription hear source revisions, each under the address the page subscribed to', async () => {
    expect(await watch(PERSON_PAGE, { chat: TOPIC })).toMatchObject({ ok: true });
    await notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: [A] }]);
    const places = sent.filter((s) => s.id === PERSON_PAGE && s.event.type === 'filesChanged').map((s) => (s.event as { place?: unknown }).place);
    expect(places).toEqual([{ chat: CHAT }, { chat: TOPIC }]);
    expect(reads.asked.filter((read) => read.reader === null)).toEqual([{ chatId: CHAT, reader: null, ids: [A], all: false }]);
    expect(await watch(PERSON_PAGE, { chat: TOPIC }, false)).toMatchObject({ ok: true });
    sent.length = 0;
    await notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: [B] }]);
    expect(changesTo(PERSON_PAGE)).toHaveLength(1);
  });

  it('each page hears the named files as its reader sees them — one read per reader, a page of another chat nothing', async () => {
    await notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: [A, B] }]);
    expect(reads.asked).toEqual([
      { chatId: CHAT, reader: null, ids: [A, B], all: false },
      { chatId: CHAT, reader: AGENT, ids: [A, B], all: false },
    ]);
    expect(changesTo(PERSON_PAGE)).toEqual([{ kind: 'entries', entries: [
      { id: A, chat: CHAT, name: 'a.md', version: 2 }, { id: B, chat: CHAT, name: 'b.md', version: 2 },
    ], gone: [] }]);
    // The agent's page: B is not there for it.
    expect(changesTo(AGENT_PAGE)).toEqual([{ kind: 'entries', entries: [{ id: A, chat: CHAT, name: 'a.md', version: 2 }], gone: [B] }]);
    expect(changesTo(OTHER_PAGE)).toEqual([]);
    // Never a resync for a chat: nothing has a page list it again.
    expect(JSON.stringify(sent)).not.toContain('resync');
  }, 60_000);

  it('ids named while a read is on its way wait for it, and go together in exactly one more', async () => {
    let release!: () => void;
    reads.hold = new Promise<void>((resolve) => (release = resolve));
    const first = notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: [A] }]);
    await until('the first reads are on their way (one per reader)', () => reads.asked.length === 2);
    const second = notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: [B] }]);
    const third = notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: [C, B] }]);
    // B and C wait for the read on its way: nothing more is read yet.
    expect(reads.asked.map((read) => read.ids)).toEqual([[A], [A]]);
    reads.hold = null;
    release();
    await Promise.all([first, second, third]);
    expect(reads.asked.filter((read) => read.reader === null).map((read) => read.ids)).toEqual([[A], [B, C]]);
    expect(changesTo(PERSON_PAGE).map((change) => (change as { entries: { id: string }[] }).entries.map((entry) => entry.id))).toEqual([[A], [B, C]]);
  }, 60_000);

  it('a read that fails twice: its files go with the next ones named, so the page is not left on the old ones', async () => {
    reads.failFor = { reader: null, times: 2 };
    await notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: [A] }]);
    // Tried again at once, failed again: the person's page has nothing yet (the agent's read went through).
    expect(changesTo(PERSON_PAGE)).toEqual([]);
    expect(changesTo(AGENT_PAGE)).toHaveLength(1);
    await notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: [C] }]);
    expect(reads.asked.filter((read) => read.reader === null).map((read) => read.ids)).toEqual([[A], [A], [A, C]]);
    expect(changesTo(PERSON_PAGE).map((change) => (change as { entries: { id: string }[] }).entries.map((entry) => entry.id))).toEqual([[A, C]]);
  }, 60_000);

  it('the only page hearing a chat as its reader stops: what was kept for that reader goes with it', async () => {
    reads.failFor = { reader: null, times: 2 };
    await notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: [A] }]);
    // A is kept for the person; then the person's page (the only one reading as the person) stops hearing the chat.
    expect(await watch(PERSON_PAGE, { chat: CHAT }, false)).toMatchObject({ ok: true });
    expect(await watch(PERSON_PAGE, { chat: CHAT })).toMatchObject({ ok: true });
    await notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: [C] }]);
    expect(reads.asked.filter((read) => read.reader === null).map((read) => read.ids)).toEqual([[A], [A], [C]]);
  }, 60_000);

  it('more ids kept than a read names one by one: every file of the chat is read, and a kept id not among them is said gone', async () => {
    const kept = Array.from({ length: MAX_HELD_IDS }, (_, i) => `0f000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    reads.failFor = { reader: null, times: 2 };
    await notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: kept }]);
    expect(changesTo(PERSON_PAGE)).toEqual([]);
    // One more named: past the cap — one read of every file, the ids still passed (#7257 review 2: none of them lost).
    await notifyGroupWorkspaceChanged([{ chatId: CHAT, itemIds: [C] }]);
    expect(reads.asked.filter((read) => read.reader === null).at(-1)).toEqual({ chatId: CHAT, reader: null, ids: [...kept, C].sort(), all: true });
    const [told] = changesTo(PERSON_PAGE) as { entries: { id: string }[]; gone: string[] }[];
    expect(told!.entries.map((entry) => entry.id)).toEqual([A]);
    expect(told!.gone).toEqual([...kept, C]);
  }, 60_000);

  it('the Apps installed here changed: every file of each watched chat, told the same way', async () => {
    await notifyInstalledAppsChanged();
    expect(reads.asked.map(({ chatId, reader, ids, all }) => [chatId, reader, ids, all]).sort()).toEqual(
      [[CHAT, null, [], true], [CHAT, AGENT, [], true], [OTHER_CHAT, null, [], true]].sort(),
    );
    expect(changesTo(OTHER_PAGE)).toEqual([{ kind: 'entries', entries: [{ id: A, chat: OTHER_CHAT, name: 'a.md', version: 2 }], gone: [] }]);
  }, 60_000);
});
