import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 摩擦单 F87 (S24): with the workspace list open, an App installed here left its files shown under their raw name with a
 * generic icon for ~2 minutes — until some file changed. The installed Apps changing now tells every page that asked to
 * hear about a chat's files (`files.onChanged({ chat }, fn)`, 真源原则 13) every file of that chat as it is now (#7257:
 * `entries`, with the new claims). A page that asked about no chat has no chat list to redo.
 */

const GROUP_ONE = 7;
const GROUP_TWO = 8;
const SESSION_TAB = 9;
const CHAT_ONE = '0b000000-0000-4000-8000-000000000001';
const CHAT_TWO = '0b000000-0000-4000-8000-000000000002';
const sent: { id: number; event: unknown }[] = [];
const contentsOf = (id: number) => ({
  id,
  isDestroyed: () => false,
  hostWebContents: { id: 42 },
  session: { id },
  once: () => undefined,
  on: () => undefined,
  send: (_channel: string, event: unknown) => sent.push({ id, event }),
});
const handlers = vi.hoisted(() => new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>());

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn), on: vi.fn() },
  webContents: { fromId: (id: number) => ([GROUP_ONE, GROUP_TWO, SESSION_TAB].includes(id) ? contentsOf(id) : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'workspace', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => ['files:read'], hasCapability: () => true, get: () => ({ manifest: { name: 'Workspace' } }) }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Every file of the chat, as it is now: one, claimed by the App just installed.
vi.mock('@main/core/extensions/app-files', () => ({
  resourceChatOf: async (chatId: string) => chatId,
  changedGroupFiles: async (chatId: string, _reader: string | null, wanted: { all: boolean }) =>
    wanted.all ? { entries: [{ id: `${chatId}-board`, chat: chatId, name: 'x.board.json', claimedBy: { app: { id: 'board' } } }], gone: [] } : { entries: [], gone: [] },
}));

const { bindExtensionSurface, notifyInstalledAppsChanged, onInstalledAppsChanged, registerExtensionBridge, stopPageWatches } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const watch = (id: number, place: unknown) =>
  handlers.get(EXTENSION_BRIDGE_CHANNEL)!({ sender: contentsOf(id) }, { method: 'filesWatch', args: { watchId: JSON.stringify(place), place, on: true } });

beforeEach(async () => {
  for (const id of [GROUP_ONE, GROUP_TWO, SESSION_TAB]) stopPageWatches(id);
  sent.length = 0;
  await bindExtensionSurface({ webContentsId: GROUP_ONE, extensionId: 'workspace', tabId: 'slot-1', tabKind: 'workspace.main', chatId: CHAT_ONE });
  await bindExtensionSurface({ webContentsId: GROUP_TWO, extensionId: 'workspace', tabId: 'slot-2', tabKind: 'workspace.main', chatId: CHAT_TWO });
  await bindExtensionSurface({ webContentsId: SESSION_TAB, extensionId: 'workspace', sessionId: 'task-1', tabId: 'tab-1', tabKind: 'workspace.main' });
  // Each chat's page asks about its chat's files; the session's tab asks about none.
  expect(await watch(GROUP_ONE, { chat: CHAT_ONE })).toMatchObject({ ok: true });
  expect(await watch(GROUP_TWO, { chat: CHAT_TWO })).toMatchObject({ ok: true });
  sent.length = 0;
});

describe('the Apps installed here changed (摩擦单 F87)', () => {
  it('every page hearing a chat is told its files with the new claims, which chat; a page hearing none is not told', async () => {
    // Control: pages open, the Apps not yet changed — nothing reaches them (before F87 this stayed so until a file changed).
    expect(sent).toEqual([]);
    await notifyInstalledAppsChanged();
    const told = sent.filter(({ event }) => (event as { type?: string }).type === 'filesChanged');
    expect(told.map(({ id }) => id).sort()).toEqual([GROUP_ONE, GROUP_TWO]);
    expect(told.find(({ id }) => id === GROUP_TWO)?.event).toMatchObject({
      type: 'filesChanged', place: { chat: CHAT_TWO }, change: { kind: 'entries', entries: [{ chat: CHAT_TWO, claimedBy: { app: { id: 'board' } } }], gone: [] },
    });
    expect(sent.some(({ id }) => id === SESSION_TAB)).toBe(false);
  });

  it('#7317 main hears it too, and one listener that throws stops neither the others nor the pages', async () => {
    // Computer Use is the switch of this computer's computer control: it must follow the App at once.
    const heard: string[] = [];
    const offBroken = onInstalledAppsChanged(() => { throw new Error('broken listener'); });
    const off = onInstalledAppsChanged(() => heard.push('switch'));
    await notifyInstalledAppsChanged();
    expect(heard).toEqual(['switch']);
    expect(sent.some(({ id }) => id === GROUP_ONE)).toBe(true);
    // Control: once it stops listening it hears nothing more.
    off();
    offBroken();
    await notifyInstalledAppsChanged();
    expect(heard).toEqual(['switch']);
  });
});
