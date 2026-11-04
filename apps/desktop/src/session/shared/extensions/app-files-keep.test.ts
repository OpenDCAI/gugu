// 「设为临时 / 一直保留」 (gugu-supabase #68/#69): what the folder's list says of a file's cloud copy (entry.keep), and
// files.keep — one file's current version, as whoever acts, through file_storage_mark_as; the door's refusals as codes.
import { beforeEach, expect, it, vi } from 'vitest';
import type { FilesPlatform } from './app-files-core';

const person = '11111111-1111-4111-8111-111111111111';
const agent = '22222222-2222-4222-8222-222222222222';
const chat = '33333333-3333-4333-8333-333333333333';
const item = '44444444-4444-4444-8444-444444444444';
const base = { chat_id: chat, kind: 'file', content_type: 'application/pdf', size_bytes: 2, pointer: 'chat/x', source_message_ids: [],
  created_by: person, version: 1, epoch: 0, parent_id: null, system_role: null, created_at: null, updated_at: null, metadata: {} };
// As workspace_list_as answers since #69: a temporary copy of mine, someone else's kept one, a file with no cloud copy.
const listed = [
  { ...base, id: item, filename: 'mine.pdf', path: 'mine.pdf', expires_at: '2026-11-04T00:00:00Z', is_mine: true },
  { ...base, id: 'theirs', filename: 'theirs.pdf', path: 'theirs.pdf', expires_at: null, is_mine: false },
  { ...base, id: 'doc', kind: 'document', filename: 'notes.md', path: 'notes.md', pointer: null, expires_at: null, is_mine: null },
];
// As workspace_get_as answers one file: without the two.
const { expires_at: _expires, is_mine: _mine, ...single } = listed[0]!;
let refusal: { message: string; hint: string } | null = null;
const rpc = vi.fn((name: string, _args: Record<string, unknown>) => {
  const data = name === 'workspace_list_as' ? listed
    : name === 'workspace_get_as' ? [single]
      : name === 'workspace_deletable_as' ? [] : name === 'file_storage_mark_as' ? 1 : [];
  const answer = Promise.resolve(name === 'file_storage_mark_as' && refusal ? { data: null, error: refusal } : { data, error: null });
  return Object.assign(answer, { select: () => answer });
});
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }));
const { createAppFiles } = await import('./app-files-core');
const page = { pageId: 9, extensionId: 'workspace', itemId: null, asAgent: null };
let platform: FilesPlatform;
beforeEach(() => {
  vi.clearAllMocks();
  refusal = null;
  platform = { account: async () => ({ token: 'token', userId: person }), hasCapability: () => true,
    sync: { pageFor: () => ({}), grant: vi.fn(), ungrant: vi.fn(), revoke: vi.fn() } as never,
    identities: async () => [], faces: async () => ({}), filesUrl: () => 'http://files.invalid', warn: vi.fn() };
});

it('the list says how long each cloud copy is kept and whose it is; no cloud copy says null', async () => {
  const entries = await createAppFiles(platform).groupFiles(chat);
  expect(entries.map((entry) => [entry.id, entry.keep])).toEqual([
    [item, { expiresAt: '2026-11-04T00:00:00Z', mine: true }],
    ['theirs', { expiresAt: null, mine: false }],
    ['doc', null],
  ]);
});

it('a read that does not say (one file at a time) leaves keep out rather than saying there is no copy', async () => {
  const { entries } = await createAppFiles(platform).groupEntries(chat, [item]);
  expect(entries[0]).not.toHaveProperty('keep');
});

it('keeps one file\'s current copy as whoever acts: the person, or the agent the page works as', async () => {
  const files = createAppFiles(platform);
  await files.keep(page, { refs: [{ id: item }], how: 'permanent' });
  expect(rpc).toHaveBeenLastCalledWith('file_storage_mark_as', { p_refs: [{ item_id: item }], p_action: 'permanent', p_as: person });
  await files.keep({ ...page, asAgent: agent }, { refs: [{ id: item }], how: 'temporary' });
  expect(rpc).toHaveBeenLastCalledWith('file_storage_mark_as', { p_refs: [{ item_id: item }], p_action: 'temporary', p_as: agent });
});

it('keeps several in one call, and says how many the database changed', async () => {
  const files = createAppFiles(platform);
  rpc.mockClear();
  // The rig has one file (workspace_get_as), named twice here; the door answers 1 changed.
  const kept = await files.keep(page, { refs: [{ id: item }, { id: item, chat }], how: 'temporary' });
  const marks = rpc.mock.calls.filter(([name]) => name === 'file_storage_mark_as');
  expect(marks).toHaveLength(1);
  expect(marks[0]![1]).toMatchObject({ p_refs: [{ item_id: item }, { item_id: item }], p_action: 'temporary' });
  expect(kept).toEqual({ changed: 1 });
  await expect(files.keep(page, { refs: [], how: 'temporary' })).rejects.toMatchObject({ code: 'invalid' });
});

it('asks nothing of the database for a way it does not know, and says the door\'s refusals as codes', async () => {
  const files = createAppFiles(platform);
  await expect(files.keep(page, { refs: [{ id: item }], how: 'release' })).rejects.toMatchObject({ code: 'invalid' });
  expect(rpc.mock.calls.some(([name]) => name === 'file_storage_mark_as')).toBe(false);
  refusal = { message: 'Only the person who uploaded a file can change how long it is kept', hint: 'file_transfer_denied' };
  await expect(files.keep(page, { refs: [{ id: item }], how: 'permanent' })).rejects.toMatchObject({ code: 'denied' });
  refusal = { message: 'This file has no cloud copy', hint: 'file_transfer_invalid' };
  await expect(files.keep(page, { refs: [{ id: item }], how: 'permanent' })).rejects.toMatchObject({ code: 'invalid' });
});
