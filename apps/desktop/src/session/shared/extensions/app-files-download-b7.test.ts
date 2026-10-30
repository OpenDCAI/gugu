import { rpcQuery } from '../../../../../../tests/helpers/rpcQuery';
import { verifiedFileHandle } from '../../../../../../tests/helpers/verifiedFileHandle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesPlatform } from './app-files-core';
/**
 * L11 B7: saving a document of the workspace (`gugu.files.download`) writes what the file is now — read from the file
 * service, as an agent's download is (MCP `workspaceDocumentCopy`) — not `inline_text`, which is only its last save (and,
 * for a file nobody has opened, can still hold `{"$text": …}` marks). Then nothing but the file service reads a
 * document's text, and the marks' projection can go with M2.
 */
const PERSON = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const row = {
  id: ITEM, chat_id: CHAT, kind: 'document', filename: 'board.json', content_type: 'application/json', size_bytes: 20,
  created_at: null, updated_at: null, created_by: PERSON, source_message_ids: [], pointer: null, epoch: 3,
  inline_text: '{"cards":{"$text":"saved long ago"}}',
};
function table(_name: string) {
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    maybeSingle: async () => ({ data: row, error: null }),
    single: async () => ({ data: row, error: null }),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve({ data: [row], error: null }).then(resolve, reject),
  };
  return query;
}
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({ from: table, rpc: rpcQuery(async (name: string, args: Record<string, unknown>) => (name === 'workspace_deletable_as' ? { data: args.p_item_ids, error: null } : { data: [row], error: null })) }),
}));
const { createAppFiles } = await import('./app-files-core');
const platform: FilesPlatform = {
  account: async () => ({ token: 'token', userId: PERSON }),
  hasCapability: () => true,
  sync: { ensureFor: () => undefined, pageFor: () => ({}), grant: () => undefined, revoke: () => undefined, ungrant: () => undefined } as never,
  identities: async () => [],
  faces: async () => ({}),
  filesUrl: () => 'http://files.test',
  warn: () => undefined,
  resolveFile: async (_ref, _actor, { localOnly }) => localOnly ? null : verifiedFileHandle(new Uint8Array([1, 2, 3]), {
    item_id: ITEM, chat_id: CHAT, version: 1, file_name: row.filename, content_type: row.content_type,
  }),
};
const files = createAppFiles(platform);

beforeEach(() => Object.assign(row, { kind: 'document', filename: 'board.json', content_type: 'application/json' }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saving a document of the workspace reads it from the file service (L11 B7)', () => {
  it.each([
    ['周报', 'text/markdown', '周报.md'],
    ['投票', 'application/json', '投票.json'],
    ['report.HTM', 'text/html', 'report.HTM'],
  ])('saves a document titled %s (%s) as %s', async (filename, contentType, expected) => {
    Object.assign(row, { filename, content_type: contentType });
    vi.stubGlobal('fetch', async () => Response.json({ epoch: 3, contentType, text: 'current contents', live: true }));
    await expect(files.downloadSource({ pageId: 7, extensionId: 'board', itemId: ITEM }, { ref: { chat: CHAT, id: ITEM } }))
      .resolves.toEqual({ name: expected, kind: 'text', text: 'current contents' });
    expect(row.filename).toBe(filename);
  });

  it.each([
    ['报告', 'application/pdf', '报告.pdf'],
    ['截图.v2', 'image/png', '截图.v2.png'],
    ['报告.final', 'application/pdf', '报告.final.pdf'],
    ['photo.jpeg', 'image/jpeg', 'photo.jpeg'],
  ])('saves stored %s (%s) as %s', async (filename, contentType, expected) => {
    Object.assign(row, { kind: 'file', filename, content_type: contentType });
    const source = await files.downloadSource({ pageId: 7, extensionId: 'board', itemId: ITEM }, { ref: { chat: CHAT, id: ITEM } });
    expect(source).toMatchObject({ name: expected, kind: 'file' });
    expect(row.filename).toBe(filename);
    if (source.kind === 'file') await source.file.dispose();
  });

  it('the text is the file as it is now, asked as the person — not its last save', async () => {
    const asked: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      asked.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ epoch: 3, contentType: 'application/json', text: '{\n  "cards": "typed a moment ago"\n}', live: true }));
    });
    const source = await files.downloadSource({ pageId: 7, extensionId: 'board', itemId: ITEM }, { ref: { chat: CHAT, id: ITEM } });
    // Control (before B7): `inline_text` indented — the old save, its mark in it.
    expect(source).toEqual({ name: 'board.json', kind: 'text', text: '{\n  "cards": "typed a moment ago"\n}' });
    expect(asked).toEqual([{ url: `http://files.test/${ITEM}`, headers: { Authorization: 'Bearer token' } }]);
  });

  it('a page acting for an agent asks as that agent; a refusal is said, not a stale copy', async () => {
    const asked: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      asked.push(init.headers);
      return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 });
    });
    const saving = files.downloadSource({ pageId: 7, extensionId: 'board', itemId: ITEM, asAgent: AGENT }, { ref: { id: ITEM } });
    await expect(saving).rejects.toMatchObject({ code: 'not-found' });
    expect(asked).toEqual([{ Authorization: 'Bearer token', 'X-Gugu-As-Agent': AGENT }]);
  });
});
