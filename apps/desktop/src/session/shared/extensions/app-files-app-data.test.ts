import { beforeEach, expect, it, vi } from 'vitest';
import type { FilesPlatform } from './app-files-core';

const person = '11111111-1111-4111-8111-111111111111';
const agent = '22222222-2222-4222-8222-222222222222';
const chat = '33333333-3333-4333-8333-333333333333';
const item = '44444444-4444-4444-8444-444444444444';
const owner = { publisher: 'gugu', id: 'kanban' };
const row = { id: item, chat_id: chat, kind: 'document', filename: 'data', content_type: 'application/json', size_bytes: 2, pointer: null,
  source_message_ids: [], created_by: person, version: 1, epoch: 0, parent_id: null, system_role: null, path: 'data', created_at: null, updated_at: null, metadata: { document: { retained: true } } };
const rpc = vi.fn((name: string, _args: Record<string, unknown>) => {
  const data = name === 'chat_facts' ? [{ id: 'topic', kind: 'topic', source_chat_id: chat }] : name === 'workspace_deletable_as' ? [item] : name === 'workspace_mark_app_data_as'
    ? { ...row.metadata, app: owner } : name === 'workspace_create_app_document_as'
      ? { ...row, metadata: { app: owner } } : [row];
  const answer = Promise.resolve({ data, error: null });
  return Object.assign(answer, { select: () => answer });
});
const readSettings = vi.fn(async () => ({ other: 'keep', workspace: { layout: 'list' } }));
const writeSettings = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }));
vi.mock('@gugu/core/cloud/userSettings', () => ({
  readUserSettingsConfig: (...args: unknown[]) => readSettings(...args as []),
  updateUserSettingsConfig: async (client: unknown, userId: string, scope: string, edit: (config: Record<string, unknown>) => Record<string, unknown>) => {
    const config = await readSettings();
    return writeSettings(client, userId, scope, edit(config));
  },
}));
const { createAppFiles } = await import('./app-files-core');
const page = { pageId: 9, extensionId: 'kanban', itemId: null, asAgent: agent };
let platform: FilesPlatform;
beforeEach(() => {
  vi.clearAllMocks();
  platform = { account: async () => ({ token: 'token', userId: person }), appIdentity: () => owner, hasCapability: () => true,
    sync: { pageFor: () => ({}), grant: vi.fn(), ungrant: vi.fn(), revoke: vi.fn() } as never,
    identities: async () => [], faces: async () => ({}), filesUrl: () => 'http://files.invalid', warn: vi.fn() };
});

it('creates marked data using installed identity and the calling agent, while ordinary creation stays unmarked', async () => {
  const files = createAppFiles(platform);
  const entry = await files.create(chat, { name: 'Board', content: '{}', contentType: 'application/json', appData: true }, { extensionId: page.extensionId, asAgent: agent });
  expect(rpc).toHaveBeenCalledWith('workspace_create_app_document_as', expect.objectContaining({ p_app: owner, p_as_user_id: agent }));
  expect(entry.metadata).toEqual({ app: owner });
  rpc.mockClear();
  await files.create(chat, { name: 'Budget.xlsx', content: 'ordinary document' });
  expect(rpc).toHaveBeenCalledWith('workspace_create_document_as', expect.not.objectContaining({ p_app: expect.anything() }));
});

it('marks an existing file only on explicit open, preserving document metadata', async () => {
  const files = createAppFiles(platform);
  const opened = await files.open(page, { ref: { id: item }, appData: true, deferDetails: true });
  expect(rpc).toHaveBeenCalledWith('workspace_mark_app_data_as', { p_item_id: item, p_as_user_id: agent, p_app: owner });
  expect(opened.entry.metadata).toEqual({ ...row.metadata, app: owner });
  rpc.mockClear();
  await files.open(page, { ref: { id: item }, deferDetails: true });
  expect(rpc.mock.calls.some(([name]) => name === 'workspace_mark_app_data_as')).toBe(false);
});

it('refuses marking without write access or a recorded publisher before issuing a mark', async () => {
  platform.hasCapability = () => false;
  await expect(createAppFiles(platform).open({ ...page, itemId: item }, { ref: { id: item }, readOnly: true, appData: true })).rejects.toMatchObject({ code: 'denied' });
  platform.hasCapability = () => true;
  platform.appIdentity = () => null;
  await expect(createAppFiles(platform).create(chat, { name: 'state', content: '{}', appData: true }, { extensionId: 'kanban' })).rejects.toMatchObject({ code: 'invalid' });
  expect(rpc.mock.calls.some(([name]) => name === 'workspace_mark_app_data_as' || name === 'workspace_create_app_document_as')).toBe(false);
});

it('returns all entries with metadata and preserves it after a move', async () => {
  const files = createAppFiles(platform);
  expect(await files.groupFiles(chat)).toMatchObject([{ metadata: row.metadata }]);
  expect(await files.move(page, { ref: { id: item }, name: 'Renamed' })).toMatchObject({ metadata: row.metadata });
});

it('keeps the preference on the signed-in person/source chat and preserves other settings', async () => {
  const files = createAppFiles(platform);
  expect(await files.viewPreferences('topic')).toEqual({ showAppData: false });
  expect(readSettings).toHaveBeenLastCalledWith(expect.anything(), person, `chat:${chat}`);
  expect(await files.viewPreferences('topic', true)).toEqual({ showAppData: true });
  expect(writeSettings).toHaveBeenLastCalledWith(expect.anything(), person, `chat:${chat}`, { other: 'keep', workspace: { layout: 'list', show_app_data: true } });
  platform.account = async () => ({ token: 'another-token', userId: agent });
  expect(await files.viewPreferences(chat)).toEqual({ showAppData: false });
  expect(readSettings).toHaveBeenLastCalledWith(expect.anything(), agent, `chat:${chat}`);
});
