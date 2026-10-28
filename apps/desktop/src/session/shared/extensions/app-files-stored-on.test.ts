import { beforeEach, expect, it, vi } from 'vitest';
import type { FilesPlatform } from './app-files-core';

const person = '11111111-1111-4111-8111-111111111111';
const host = '22222222-2222-4222-8222-222222222222';
const chat = '33333333-3333-4333-8333-333333333333';
const base = { chat_id: chat, content_type: 'application/pdf', size_bytes: 2, source_message_ids: [], created_by: person, version: 1, epoch: 0,
  parent_id: null, system_role: null, created_at: null, updated_at: null };
// A file kept on the machine (no blob pointer), one uploaded, and a document.
const rows = [
  { ...base, id: 'local', kind: 'file', filename: 'local.pdf', pointer: null, path: 'local.pdf' },
  { ...base, id: 'cloud', kind: 'file', filename: 'cloud.pdf', pointer: 'workspace/x', path: 'cloud.pdf' },
  { ...base, id: 'doc', kind: 'document', filename: 'notes.md', pointer: null, path: 'notes.md' },
];
let policy: Record<string, unknown> | null = null;
const label = vi.fn(async () => ({ data: { label: 'Studio Mac' }, error: null }));
const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
  const data = name === 'chat_facts' ? [{ id: chat, kind: 'group', source_chat_id: null }] : name === 'workspace_deletable_as' ? args.p_item_ids
    : name === 'file_project_policy_for' ? policy : rows;
  const answer = Promise.resolve({ data, error: null });
  return Object.assign(answer, { select: () => answer });
});
const devices = { select: () => devices, eq: () => devices, maybeSingle: label };
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({ rpc, from: () => devices }) }));
const { createAppFiles } = await import('./app-files-core');
let platform: FilesPlatform;
beforeEach(() => {
  vi.clearAllMocks();
  policy = null;
  platform = { account: async () => ({ token: 'token', userId: person }), hasCapability: () => true,
    sync: { pageFor: () => ({}), grant: vi.fn(), ungrant: vi.fn(), revoke: vi.fn() } as never,
    identities: async (_token, ids) => ids.map((id) => ({ id, name: id === host ? 'Ming' : 'Me', avatar: null, kind: 'human' as const })),
    faces: async () => ({}), filesUrl: () => 'http://files.invalid', warn: vi.fn() };
});

it('says which machine keeps a project chat file without a cloud copy, and whose setting it follows', async () => {
  policy = { host_device_id: 'device', host_account_id: host };
  const entries = await createAppFiles(platform).groupFiles(chat);
  expect(entries.find((entry) => entry.id === 'local')?.storedOn).toEqual({ machine: null, owner: 'Ming', mine: false });
  expect(entries.find((entry) => entry.id === 'cloud')?.storedOn).toBeUndefined();
  expect(entries.find((entry) => entry.id === 'doc')?.storedOn).toBeUndefined();
  // Another person's machine: its name is theirs to read.
  expect(label).not.toHaveBeenCalled();
});

it('names the reader\'s own machine', async () => {
  policy = { host_device_id: 'device', host_account_id: person };
  const entries = await createAppFiles(platform).groupFiles(chat);
  expect(entries.find((entry) => entry.id === 'local')?.storedOn).toEqual({ machine: 'Studio Mac', owner: 'Me', mine: true });
});

it('marks nothing in a chat that is not bound to a machine', async () => {
  const entries = await createAppFiles(platform).groupFiles(chat);
  expect(entries.every((entry) => entry.storedOn === undefined)).toBe(true);
});
