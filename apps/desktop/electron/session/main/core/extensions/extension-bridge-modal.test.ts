import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionHostEvent, ExtensionBridgeResponse } from '@shared/extensions/bridge-protocol';
import type { ExtensionHostAction } from '@shared/extensions/host-actions';

const root = mkdtempSync(join(tmpdir(), 'gugu-app-modal-145-'));
writeFileSync(join(root, 'new.html'), '<input autofocus>');
const received: { page: number; event: ExtensionHostEvent }[] = [];
const actions: { window: number | null; action: ExtensionHostAction }[] = [];
const contents = new Map([1, 2, 3, 4, 42, 43].map((id) => [id, {
  id, session: { extensionId: id === 3 ? 'other-app' : 'board' }, hostWebContents: { id: id === 4 ? 43 : 42 },
  isDestroyed: () => false, on: vi.fn(), once: vi.fn(),
  send: (_channel: string, event: ExtensionHostEvent) => received.push({ page: id, event }),
}]));
const handlers = new Map<string, (event: unknown, args: unknown) => Promise<ExtensionBridgeResponse>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (event: unknown, args: unknown) => Promise<ExtensionBridgeResponse>) => handlers.set(name, fn), on: vi.fn() },
  webContents: { fromId: (id: number) => contents.get(id) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: (session: { extensionId: string }) => session.extensionId, isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({
  grantedCapabilities: () => [], hasCapability: () => false, get: () => ({ rootDir: root, manifest: { name: 'Board' } }),
}) }));
vi.mock('@main/core/extensions/app-files', () => ({ resourceChatOf: async (id: string) => id, chatMembersOf: async () => [], surfaceChatOf: async () => ({ id: 'chat-one', name: 'Group', kind: 'group', groupId: 'chat-one' }) }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { bindExtensionSurface, bindAppModalSurface, registerExtensionBridge, setExtensionBridgeHost, unbindExtensionSurfaces } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const call = (page: number, method: string, args: Record<string, unknown> = {}) => handlers.get(EXTENSION_BRIDGE_CHANNEL)!({ sender: contents.get(page) }, { method, args });
const open = () => call(1, 'modalOpen', { id: 'one', entry: 'new.html', title: 'New card', data: { column: 'todo' } });

beforeEach(async () => {
  setExtensionBridgeHost({ deliver: async (origin, action) => { actions.push({ window: origin.embedderId, action }); }, presentation: () => ({ locale: 'en', themeMode: 'dark', fullscreen: false, windowFocused: true }) });
  await bindExtensionSurface({ webContentsId: 1, extensionId: 'board', tabId: 'slot', tabKind: 'board.main', chatId: 'chat-one', itemId: 'board-file' });
  await bindExtensionSurface({ webContentsId: 3, extensionId: 'other-app', tabId: 'other', tabKind: 'other-app.main' });
  received.length = 0; actions.length = 0;
});
afterEach(async () => { await call(42, 'modalHost', { type: 'dismiss', id: 'one' }); unbindExtensionSurfaces('board'); unbindExtensionSurfaces('other-app'); });
afterAll(() => { unlinkSync(join(root, 'new.html')); rmdirSync(root); });

describe('the App modal bridge', () => {
  it('opens on its own window without capabilities and inherits the handed file and initial data', async () => {
    const result = open();
    await vi.waitFor(() => expect(actions[0]?.action.kind).toBe('openAppModal'));
    expect(actions[0]).toMatchObject({ window: 42, action: { kind: 'openAppModal', page: { extensionId: 'board', partition: 'persist:gugu-extension-board', entryUrl: 'gugu-ext://board/new.html' } } });
    expect(await call(42, 'modalHost', { type: 'bind', id: 'one', webContentsId: 2 })).toEqual({ ok: true, value: undefined });
    expect(await call(42, 'modalHost', { type: 'focus', id: 'one', edge: 'last' })).toEqual({ ok: true, value: undefined });
    expect(received).toContainEqual({ page: 2, event: { type: 'modalFocus', edge: 'last' } });
    expect(await call(2, 'getContext')).toMatchObject({ ok: true, value: { file: { chat: 'chat-one', id: 'board-file' }, modal: { data: { column: 'todo' } }, capabilities: [] } });
    expect(await call(2, 'modalClose', { result: { cardId: 'created' } })).toEqual({ ok: true, value: undefined });
    expect(await result).toEqual({ ok: true, value: { cardId: 'created' } });
  });

  it('cannot be closed by its opener or another App; the host can cancel it', async () => {
    const result = open();
    await vi.waitFor(() => expect(actions[0]?.action.kind).toBe('openAppModal'));
    expect(await call(1, 'modalClose')).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call(3, 'modalClose')).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call(1, 'modalHost', { type: 'dismiss', id: 'one' })).toMatchObject({ ok: false, code: 'denied' });
    expect(await call(43, 'modalHost', { type: 'dismiss', id: 'one' })).toMatchObject({ ok: false, code: 'denied' });
    await call(42, 'modalHost', { type: 'dismiss', id: 'one' });
    expect(await result).toEqual({ ok: true, value: null });
  });

  it('refuses a different App or another window as the content surface', async () => {
    const result = open();
    await vi.waitFor(() => expect(actions[0]?.action.kind).toBe('openAppModal'));
    await expect(bindAppModalSurface({ id: 'one', webContentsId: 4 })).rejects.toThrow('same window');
    await expect(bindAppModalSurface({ id: 'one', webContentsId: 3 })).rejects.toThrow('not "board"');
    expect(await result).toMatchObject({ ok: false, code: 'failed' });
  });

  it('rejects outside entries without showing a dialog', async () => {
    expect(await call(1, 'modalOpen', { id: 'one', entry: '../outside.html', title: 'New' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(actions).toEqual([]);
  });
});
