import { beforeEach, expect, it, vi } from 'vitest';
import type { FilesPlatform } from './app-files-core';

const person = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const chat = '33333333-3333-4333-8333-333333333333';
const base = { chat_id: chat, content_type: 'application/pdf', size_bytes: 2, source_message_ids: [], created_by: person, version: 1, epoch: 0,
  parent_id: null, system_role: null, created_at: null, updated_at: null };
// Files kept on machines (no blob pointer) — two on one machine, one on another — one uploaded, and a document.
let rows: Record<string, unknown>[] = [];
// Each file's current version, as the one metadata entry point resolves it: the machine that keeps it, for any reader.
let holders: Record<string, Record<string, unknown>> = {};
const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
  const data = name === 'chat_facts' ? [{ id: chat, kind: 'group', source_chat_id: null }] : name === 'workspace_deletable_as' ? args.p_item_ids
    : name === 'file_resolve_as' ? holders[(args.p_ref as { item_id: string }).item_id] ?? { status: 'gone' } : rows;
  const answer = Promise.resolve({ data, error: null });
  return Object.assign(answer, { select: () => answer });
});
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc }) }));
const { createAppFiles } = await import('./app-files-core');
let platform: FilesPlatform;
const kept = (device: string, account: string, label: string, online: boolean) =>
  ({ status: 'ready', source: 'local', host_device_id: device, host_account_id: account, host_label: label, host_online: online });
beforeEach(() => {
  vi.clearAllMocks();
  rows = [
    { ...base, id: 'mac-a', kind: 'file', filename: 'a.pdf', pointer: null, path: 'a.pdf', host_device_id: 'mac' },
    { ...base, id: 'mac-b', kind: 'file', filename: 'b.pdf', pointer: null, path: 'b.pdf', host_device_id: 'mac' },
    { ...base, id: 'linux', kind: 'file', filename: 'c.pdf', pointer: null, path: 'c.pdf', host_device_id: 'linux' },
    { ...base, id: 'cloud', kind: 'file', filename: 'cloud.pdf', pointer: 'workspace/x', path: 'cloud.pdf', host_device_id: null },
    { ...base, id: 'doc', kind: 'document', filename: 'notes.md', pointer: null, path: 'notes.md', host_device_id: null },
  ];
  holders = { 'mac-a': kept('mac', person, 'Studio Mac', true), 'mac-b': kept('mac', person, 'Studio Mac', true), linux: kept('linux', other, 'Linux 1', false) };
  platform = { account: async () => ({ token: 'token', userId: person }), hasCapability: () => true,
    sync: { pageFor: () => ({}), grant: vi.fn(), ungrant: vi.fn(), revoke: vi.fn() } as never,
    identities: async (_token, ids) => ids.map((id) => ({ id, name: id === other ? 'Ming' : 'Me', avatar: null, kind: 'human' as const })),
    faces: async () => ({}), filesUrl: () => 'http://files.invalid', warn: vi.fn() };
});

it('says, file by file, which machine keeps it, whose setting it follows and whether that machine is on', async () => {
  const entries = await createAppFiles(platform).groupFiles(chat);
  const of = (id: string) => entries.find((entry) => entry.id === id)?.storedOn;
  expect(of('mac-a')).toEqual({ machine: 'Studio Mac', owner: 'Me', mine: true, online: true });
  expect(of('mac-b')).toEqual({ machine: 'Studio Mac', owner: 'Me', mine: true, online: true });
  // Another person's machine is named too, and said to be off: its files open once it is on.
  expect(of('linux')).toEqual({ machine: 'Linux 1', owner: 'Ming', mine: false, online: false });
  expect(of('cloud')).toBeUndefined();
  expect(of('doc')).toBeUndefined();
});

it('asks once per machine the list names', async () => {
  await createAppFiles(platform).groupFiles(chat);
  expect(rpc.mock.calls.filter(([name]) => name === 'file_resolve_as')).toHaveLength(2);
});

it('marks nothing when no file is kept on a machine', async () => {
  rows = rows.filter((row) => row.pointer || row.kind !== 'file');
  const entries = await createAppFiles(platform).groupFiles(chat);
  expect(entries.every((entry) => entry.storedOn === undefined)).toBe(true);
  expect(rpc.mock.calls.some(([name]) => name === 'file_resolve_as')).toBe(false);
});

it('a file that changed, read on its own, still says which machine keeps it', async () => {
  // `workspace_get_as` has no host_device_id: what `groupEntries` hands a page when a file gets a new version.
  const id = '44444444-4444-4444-8444-444444444444';
  rows = [{ ...base, id, kind: 'file', filename: 'a.pdf', pointer: null, path: 'a.pdf' }];
  holders = { [id]: kept('mac', person, 'Studio Mac', true) };
  const { entries } = await createAppFiles(platform).groupEntries(chat, [id]);
  expect(entries[0]?.storedOn).toMatchObject({ machine: 'Studio Mac', mine: true });
});
