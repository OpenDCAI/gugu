import { beforeEach, expect, it, vi } from 'vitest';
import type { FilesPlatform } from './app-files-core';

const person = '11111111-1111-4111-8111-111111111111';
const chat = '33333333-3333-4333-8333-333333333333';
const base = { chat_id: chat, content_type: 'image/png', size_bytes: 2, source_message_ids: [], created_by: person, version: 1, epoch: 0,
  parent_id: null, system_role: null, created_at: null, updated_at: null };
// The gateway's row cap (PostgREST db-max-rows): one answer holds at most this many, whatever the caller asked.
const GATEWAY_CAP = 1000;
let rows: Record<string, unknown>[] = [];
let betweenPages: (() => void) | null = null;
const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
  let data: unknown;
  if (name === 'chat_facts') data = [{ id: chat, kind: 'group', source_chat_id: null }];
  else if (name === 'workspace_deletable_as') data = (args.p_item_ids as string[]).filter((id) => id.endsWith('-mine'));
  else if (name === 'workspace_list_as') {
    const offset = Number(args.p_offset ?? 0);
    const limit = Math.min(Number(args.p_limit ?? Infinity), GATEWAY_CAP);
    data = rows.slice(offset, offset + limit).map((row) => ({ ...row, total: rows.length }));
    betweenPages?.();
  } else data = [];
  const answer = Promise.resolve({ data, error: null });
  return Object.assign(answer, { select: () => answer });
});
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }));
const { createAppFiles } = await import('./app-files-core');
let platform: FilesPlatform;
const file = (n: number) => ({ ...base, id: `item-${n}`, kind: 'file', filename: `img-${n}.png`, pointer: null, path: `img-${n}.png`, host_device_id: null });
beforeEach(() => {
  vi.clearAllMocks();
  betweenPages = null;
  platform = { account: async () => ({ token: 'token', userId: person }), hasCapability: () => true,
    sync: { pageFor: () => ({}), grant: vi.fn(), ungrant: vi.fn(), revoke: vi.fn() } as never,
    identities: async (_token, ids) => ids.map((id) => ({ id, name: 'Me', avatar: null, kind: 'human' as const })),
    faces: async () => ({}), filesUrl: () => 'http://files.invalid', warn: vi.fn() };
});

it('lists every file of a chat larger than one gateway answer, not the first 1000', async () => {
  rows = Array.from({ length: 2345 }, (_, n) => file(n));
  const entries = await createAppFiles(platform).groupFiles(chat);
  expect(entries).toHaveLength(2345);
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(2345);
  expect(rpc.mock.calls.filter(([name]) => name === 'workspace_list_as')).toHaveLength(3);
});

it('lists every file of a folder larger than one gateway answer', async () => {
  rows = Array.from({ length: 1001 }, (_, n) => file(n));
  expect(await createAppFiles(platform).groupFiles(chat, { folder: '附件' })).toHaveLength(1001);
});

it('lists a file once when one added between two pages pushes it onto the next', async () => {
  rows = Array.from({ length: 1001 }, (_, n) => file(n));
  betweenPages = () => { betweenPages = null; rows = [file(5000), ...rows]; };
  const entries = await createAppFiles(platform).groupFiles(chat);
  expect(entries).toHaveLength(1001);
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(1001);
});

it('asks no machine about a file the list names no machine for (its copy is in the cloud)', async () => {
  rows = Array.from({ length: 300 }, (_, n) => file(n));
  await createAppFiles(platform).groupFiles(chat);
  expect(rpc.mock.calls.some(([name]) => name === 'file_resolve_as')).toBe(false);
});

it('does not ask who may delete what for a list; asks for the files named, in order, when asked', async () => {
  rows = [file(1), { ...file(2), id: 'item-2-mine' }];
  const files = createAppFiles(platform);
  const listed = await files.groupFiles(chat);
  expect(listed.every((entry) => !('canDelete' in entry))).toBe(true);
  expect(rpc.mock.calls.some(([name]) => name === 'workspace_deletable_as')).toBe(false);
  const surface = { pageId: 'page', extensionId: 'workspace', asAgent: null } as never;
  expect(await files.canDelete(surface, { refs: [{ chat, id: 'item-2-mine' }, { chat, id: 'item-1' }] })).toEqual([true, false]);
  expect(rpc.mock.calls.filter(([name]) => name === 'workspace_deletable_as').map(([, args]) => args.p_item_ids)).toEqual([['item-2-mine', 'item-1']]);
});
