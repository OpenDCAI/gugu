import { rpcQuery } from '../../../../../../tests/helpers/rpcQuery';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesPlatform } from './app-files-core';

/**
 * #719: a project chat that keeps its files on its host machine. An agent there could not store a file's next version —
 * `files.replace` always took the cloud upload, which such a chat refuses — and every refusal reached it in the layers'
 * words ("Local revisions must be published by the host"). On the host the next version is published there, from the
 * version read; anywhere else the refusal says whose computer keeps the file and that nothing was changed. The host
 * publisher and the database are fakes; the publisher's own rules are in tests/unit/desktop/electron/projectFilePublication.test.ts.
 */

type Row = Record<string, unknown>;
const rows: Row[] = [];
const rpcs: { name: string; args: Row }[] = [];
const uploads: Row[] = [];
let moveError: { message: string; hint: string } | null = null;
let uploadRefusal: Error | null = null;

const CHAT = '33333333-3333-4333-8333-333333333333';
const ME = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const HOST_OWNER = '44444444-4444-4444-8444-444444444444';
const placed = (row: Row) => ({ ...row, parent_id: null, system_role: null, path: row.filename });

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    rpc: rpcQuery(async (name: string, args: Row) => {
      if (name === 'workspace_deletable_as') return { data: args.p_item_ids, error: null };
      rpcs.push({ name, args });
      if (name === 'file_project_policy_for') return { data: { host_device_id: 'device', host_account_id: HOST_OWNER }, error: null };
      const row = rows.find((candidate) => candidate.id === args.p_item_id);
      if (name === 'workspace_get_as') return { data: row ? [placed(row)] : null, error: null };
      if (name === 'workspace_move_as') return moveError ? { data: null, error: moveError } : { data: [placed({ ...row, filename: args.p_name })], error: null };
      return { data: null, error: { message: `no fake for ${name}` } };
    }),
  }),
}));

vi.mock('@gugu/core/cloud/attachmentsApi', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configuredEndpoint: (token: string) => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token }),
  uploadAttachmentBytes: async (_endpoint: unknown, _file: unknown, scope: Row) => {
    uploads.push(scope);
    if (uploadRefusal) throw uploadRefusal;
    return 'staging/key';
  },
  placeAttachment: async () => { throw new Error('the cloud path is not taken in these cases'); },
}));

const { createAppFiles } = await import('./app-files-core');
const { AttachmentsError } = await import('@gugu/core/cloud/attachmentsApi');

let publishFile: NonNullable<FilesPlatform['publishFile']>;
const publishCalls: Parameters<NonNullable<FilesPlatform['publishFile']>>[] = [];
const files = createAppFiles({
  publishFile: (...args) => (publishCalls.push(args), publishFile(...args)),
  account: async () => ({ token: 'token', userId: ME }),
  hasCapability: () => true,
  sync: { ensureFor: () => undefined, pageFor: () => ({}), grant: () => undefined, revoke: () => undefined, ungrant: () => undefined } as never,
  identities: async (_token, ids) => ids.map((id) => ({ id, name: id === HOST_OWNER ? '小禾' : 'someone', kind: 'human' as const, avatar: null })),
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
});
const asAgent = { pageId: 1, extensionId: 'workspace', itemId: null, asAgent: AGENT } as never;
const content = { name: '', contentType: 'text/markdown', bytes: new TextEncoder().encode('# 行程 v2').buffer as ArrayBuffer };

function stage(): Row {
  const row = { id: randomUUID(), chat_id: CHAT, kind: 'file', filename: '行程.md', content_type: 'text/markdown', size_bytes: 9,
    pointer: null, created_by: AGENT, created_at: null, updated_at: null, source_message_ids: [], version: 1, epoch: 0 };
  rows.push(row);
  return row;
}

beforeEach(() => {
  rows.length = 0;
  rpcs.length = 0;
  uploads.length = 0;
  publishCalls.length = 0;
  moveError = null;
  uploadRefusal = null;
  publishFile = async () => null;
});

const keptOnHost = expect.objectContaining({
  code: 'denied',
  message: "行程.md was not changed: this project chat keeps its files on 小禾's computer, and only an agent on that computer can change them. Nothing was changed.",
});

describe('files.replace in a project chat that keeps its files on its host', () => {
  it('on the host: the next version is published there, from the version read, and nothing goes to the cloud', async () => {
    const row = stage();
    publishFile = async () => placed({ ...row, version: 2 }) as never;
    const entry = await files.replace(asAgent, { ref: { id: row.id as string }, file: content, expectedVersion: 1 });
    expect(entry).toMatchObject({ id: row.id, version: 2 });
    expect(publishCalls).toHaveLength(1);
    const [chat, file, parent, actor, store, options] = publishCalls[0]!;
    expect({ chat, name: file.name, parent, actor, store, options }).toEqual({ chat: CHAT, name: '行程.md', parent: null, actor: AGENT, store: undefined,
      options: { next: { itemId: row.id, expectedVersion: 1 } } });
    expect(new TextDecoder().decode(file.bytes)).toBe('# 行程 v2');
    expect(uploads).toEqual([]);
  });

  it('someone stored a newer version on the host first: content-changed, saying the version it is now', async () => {
    const row = stage();
    publishFile = async () => { row.version = 2; throw new Error('File revision conflict'); };
    await expect(files.replace(asAgent, { ref: { id: row.id as string }, file: content, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'content-changed', detail: { reason: 'replaced-since', now: 2, expected: 1 } });
  });

  it('on another machine: the refusal says whose computer keeps it and that nothing was changed, never "published by the host"', async () => {
    const row = stage();
    uploadRefusal = new AttachmentsError('upload', 403, 'denied', 'Project files are not uploaded proactively');
    await expect(files.replace(asAgent, { ref: { id: row.id as string }, file: content, expectedVersion: 1 })).rejects.toEqual(keptOnHost);
    publishFile = async () => { throw new Error('Only the bound file host can publish project files'); };
    await expect(files.replace(asAgent, { ref: { id: row.id as string }, file: content, expectedVersion: 1 })).rejects.toEqual(keptOnHost);
  });
});

describe('a rename the database refuses for a file kept on another machine', () => {
  it('says it for people', async () => {
    const row = stage();
    moveError = { message: 'Remote project files are read-only', hint: 'file_transfer_read_only' };
    await expect(files.rename(asAgent, { ref: { id: row.id as string }, name: '行程（周末版）.md' })).rejects.toEqual(keptOnHost);
    moveError = { message: 'Local revisions must be published by the host', hint: 'file_transfer_read_only' };
    await expect(files.rename(asAgent, { ref: { id: row.id as string }, name: '行程（周末版）.md' })).rejects.toEqual(keptOnHost);
  });
});
