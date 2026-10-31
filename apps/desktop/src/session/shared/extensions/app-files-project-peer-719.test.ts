import { rpcQuery } from '../../../../../../tests/helpers/rpcQuery';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesPlatform } from './app-files-core';

/**
 * #719: in a project chat, an agent stores a file's next version through the shared publisher, which keeps it on the
 * agent's own machine, from the version read — on any member's machine, since a project chat has no host. A rename
 * follows the ordinary folder rules.
 */

type Row = Record<string, unknown>;
const rows: Row[] = [];
const rpcs: { name: string; args: Row }[] = [];
const uploads: Row[] = [];

const CHAT = '33333333-3333-4333-8333-333333333333';
const ME = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const placed = (row: Row) => ({ ...row, parent_id: null, system_role: null, path: row.filename });

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    rpc: rpcQuery(async (name: string, args: Row) => {
      if (name === 'workspace_deletable_as') return { data: args.p_item_ids, error: null };
      rpcs.push({ name, args });
      const row = rows.find((candidate) => candidate.id === args.p_item_id);
      if (name === 'workspace_get_as') return { data: row ? [placed(row)] : null, error: null };
      if (name === 'workspace_move_as') return { data: [placed({ ...row, filename: args.p_name })], error: null };
      return { data: null, error: { message: `no fake for ${name}` } };
    }),
  }),
}));

vi.mock('@gugu/core/cloud/attachmentsApi', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configuredEndpoint: (token: string) => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token }),
  uploadAttachmentBytes: async (_endpoint: unknown, _file: unknown, scope: Row) => {
    uploads.push(scope);
    return 'staging/key';
  },
  placeAttachment: async () => { throw new Error('the cloud path is not taken in these cases'); },
}));

const { createAppFiles } = await import('./app-files-core');

let publishFile: NonNullable<FilesPlatform['publishFile']>;
const publishCalls: Parameters<NonNullable<FilesPlatform['publishFile']>>[] = [];
const files = createAppFiles({
  publishFile: (...args) => (publishCalls.push(args), publishFile(...args)),
  account: async () => ({ token: 'token', userId: ME }),
  hasCapability: () => true,
  sync: { ensureFor: () => undefined, pageFor: () => ({}), grant: () => undefined, revoke: () => undefined, ungrant: () => undefined } as never,
  identities: async (_token, ids) => ids.map((id) => ({ id, name: 'someone', kind: 'human' as const, avatar: null })),
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
  publishFile = async () => null;
});

describe('files.replace in a project chat', () => {
  it('the next version is published on this machine, from the version read, and nothing goes to the cloud', async () => {
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

  it('someone stored a newer version first: content-changed, saying the version it is now', async () => {
    const row = stage();
    publishFile = async () => { row.version = 2; throw new Error('File revision conflict'); };
    await expect(files.replace(asAgent, { ref: { id: row.id as string }, file: content, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'content-changed', detail: { reason: 'replaced-since', now: 2, expected: 1 } });
  });

  it('an already stale copy is refused before the publisher or uploader is called', async () => {
    const row = stage();
    row.version = 2;
    await expect(files.replace(asAgent, { ref: { id: row.id as string }, file: content, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'content-changed', detail: { now: 2, expected: 1 } });
    expect(publishCalls).toEqual([]);
    expect(uploads).toEqual([]);
  });
});

describe('a rename of a file kept on a machine', () => {
  it('is the ordinary folder rename, from any member\'s machine', async () => {
    const row = stage();
    await expect(files.rename(asAgent, { ref: { id: row.id as string }, name: '行程（周末版）.md' })).resolves.toMatchObject({ name: '行程（周末版）.md' });
    expect(rpcs.some((call) => call.name === 'workspace_move_as')).toBe(true);
  });
});
