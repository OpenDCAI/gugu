import { rpcQuery } from '../../../../../../tests/support/rpcQuery';
import { createHash } from 'node:crypto';
import { cloudFileProviders } from '@gugu/core/cloud/fileProviders';
import { createFileResolver } from '@gugu/core/shared/fileResolver';
import { createCachedFileSink, type FileChunkCache } from '@gugu/core/shared/fileCache';
import { verifiedFileHandle } from '../../../../../../tests/support/verifiedFileHandle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7290 A file that came into the group folder as a chat attachment has no pointer: its bytes are in OSS, and a link to
 * them is signed by attachments/urls for that item and version — as the one asking (an App's program acting as its
 * agent asks as the agent). `gugu.files` reads it on that path (open, a kept version, a save); a file with a pointer
 * still goes to the storage bucket. The database and attachments/urls are fakes in memory.
 */
const ITEM = '44444444-4444-4444-8444-444444444444';
const CHAT = '33333333-3333-4333-8333-333333333333';
const ME = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const CDN = 'https://cdn.example.test/ab/abab?auth_key=1';
let row: Record<string, unknown>;
let signedRefs: { refs: unknown[]; as: string | undefined }[];
let answer: 'signed' | 'gone';
const storageSigned: string[] = [];

vi.mock('@gugu/core/cloud/attachmentsApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@gugu/core/cloud/attachmentsApi')>(),
  configuredEndpoint: (token: string) => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token }),
  fetchAttachmentUrls: async (_endpoint: unknown, refs: { item_id: string; version: number }[], as?: string | null) => {
    signedRefs.push({ refs, as: as ?? undefined });
    if (answer === 'gone') return { urls: [] };
    return { urls: refs.map((ref) => ({ ...ref, message_id: null, current_version: 2, url: CDN, thumb_url: null, sha256: 'ab'.repeat(32), width: null, height: null, expires_at: '2999-01-01T00:00:00Z' })) };
  },
}));
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: () => {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row, error: null }) };
      return query;
    },
    rpc: rpcQuery(async (name: string, args: Record<string, unknown>) => {
      // Who may delete what is the folder's to say; here, everyone may delete everything.
      if (name === 'workspace_deletable_as') return { data: args.p_item_ids, error: null };
      if (name === 'workspace_get_as') return { data: [row], error: null };
      if (name === 'workspace_version_as') return { data: [{ n: args.p_n, pointer: null, inline_text: null, content_type: 'application/pdf' }], error: null };
      return { data: null, error: { message: `no fake for ${name}` } };
    }),
    storage: {
      from: () => ({
        createSignedUrl: async (pointer: string) => {
          storageSigned.push(pointer);
          return { data: { signedUrl: `https://db.example.test/storage/v1/object/sign/workspace/${pointer}` }, error: null };
        },
      }),
    },
  }),
}));

const { createAppFiles } = await import('./app-files-core');
const files = createAppFiles({
  account: async () => ({ token: 'token', userId: ME }),
  resolveFile: async (ref, actor, options) => {
    if (options.localOnly) return null;
    signedRefs.push({ refs: [{ item_id: 'id' in ref ? ref.id : ITEM, version: options.version ?? row.version }], as: actor ?? ME });
    if (answer === 'gone') return { status: 'gone', sha256: null };
    return verifiedFileHandle(new Uint8Array([1, 2, 3]), { item_id: ITEM, version: options.version ?? row.version as number, file_name: String(row.filename), content_type: 'application/pdf' });
  },
  hasCapability: () => true,
  sync: { ensureFor: () => undefined,} as never,
  identities: async (_token, ids) => ids.map((id) => ({ id, name: id, avatar: null, kind: 'human' as const })),
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
});
/** The shared production provider owns signature reuse and the host's object fetch; Apps have no URL path. */
function cloudBackedFiles(body = new Uint8Array([1, 2, 3]), hostFetch: typeof fetch = fetch) {
  const chunks = new Map<string, Uint8Array>();
  const cache: FileChunkCache = { get: async (key, index) => chunks.get(`${key}:${index}`) ?? null,
    put: async (key, index, bytes) => { chunks.set(`${key}:${index}`, bytes.slice()); },
    clear: async key => { for (const entry of chunks.keys()) if (entry.startsWith(`${key}:`)) chunks.delete(entry); },
  };
  const sha256 = createHash('sha256').update(body).digest('hex');
  const cloud = cloudFileProviders({ cache, sink: async size => createCachedFileSink(cache, size), fetch: hostFetch,
    metadata: async context => answer === 'gone' ? { status: 'gone' } : { status: 'ready', source: 'managed-object',
      item_id: row.id, version: 'version' in context.ref ? context.ref.version : row.version, chat_id: CHAT,
      file_name: row.filename, content_type: 'application/pdf', size_bytes: body.length, sha256 },
    endpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { ref: unknown; as: string };
      signedRefs.push({ refs: [request.ref], as: request.as });
      return Response.json({ status: 'ready', url: CDN, sha256, size_bytes: body.length, download_id: 'test-download' });
    } }),
  });
  const resolve = createFileResolver({ ...cloud, local: async () => null, ssh: async () => null });
  return createAppFiles({ account: async () => ({ token: 'token', userId: ME }),
    resolveFile: async (ref, actor, options) => {
      if (options.localOnly) return null;
      if (!('id' in ref)) throw Error('This fixture expects an item reference');
      return resolve({ item_id: ref.id, version: options.version ?? Number(row.version) }, { accountId: ME, actorId: actor ?? ME });
    },
    hasCapability: () => true, sync: { ensureFor: () => undefined,} as never,
    identities: async (_token, ids) => ids.map(id => ({ id, name: id, avatar: null, kind: 'human' as const })),
    faces: async () => ({}), filesUrl: () => 'http://files.invalid', warn: () => undefined,
  });
}
const surface = (extra: Record<string, unknown> = {}) => ({ pageId: 1, extensionId: 'reader', itemId: null, ...extra }) as never;

beforeEach(() => {
  signedRefs = [];
  answer = 'signed';
  storageSigned.length = 0;
  row = { id: ITEM, chat_id: CHAT, kind: 'file', filename: 'report.pdf', content_type: 'application/pdf', pointer: null, version: 2, epoch: 0 };
  vi.stubGlobal('fetch', async (url: string) => (url === CDN ? new Response(new Uint8Array([1, 2, 3])) : new Response('not here', { status: 404 })));
});

describe('gugu.files on a file whose bytes are in OSS (#7290)', () => {
  it('a save resolves that item\'s current version through the canonical file provider, as the agent an App\'s program acts for', async () => {
    const source = await files.downloadSource(surface({ asAgent: AGENT }), { ref: { id: ITEM } });
    expect(source).toMatchObject({ name: 'report.pdf', kind: 'file', file: { purpose: 'file', revision: { item_id: ITEM, version: 2 } } });
    expect(source).not.toHaveProperty('url');
    if (source.kind === 'file') await source.file.dispose();
    expect(signedRefs).toEqual([{ refs: [{ item_id: ITEM, version: 2 }], as: AGENT }]);
    expect(storageSigned).toEqual([]);
  });

  it('a kept version is read by its own number; the person asks as themselves', async () => {
    const version = await files.readVersion(surface(), { ref: { id: ITEM }, n: 1 });
    expect(version).toMatchObject({ n: 1, contentType: 'application/pdf' });
    expect(new Uint8Array((version as { bytes: ArrayBuffer }).bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(signedRefs).toEqual([{ refs: [{ item_id: ITEM, version: 1 }], as: ME }]);
  });

  it('a version the resolver does not answer for is not-found, said — never an empty file', async () => {
    answer = 'gone';
    await expect(files.readVersion(surface(), { ref: { id: ITEM }, n: 3 })).rejects.toMatchObject({ code: 'not-found', message: expect.stringMatching(/has no bytes for version 3/) });
  });

  it('a version signed once is not signed again while its link holds; another version, or another reader, is (10-25)', async () => {
    row = { ...row, id: '55555555-5555-4555-8555-555555555555', version: 7 };
    const cached = cloudBackedFiles();
    const open = (extra?: Record<string, unknown>) => cached.open(surface(extra), { ref: { id: row.id as string } });
    expect(new Uint8Array((await open()).bytes!)).toEqual(new Uint8Array([1, 2, 3]));
    await open();
    expect(signedRefs).toEqual([{ refs: [{ item_id: row.id, version: 7 }], as: ME }]);
    row = { ...row, version: 8 };
    await open();
    await open({ asAgent: AGENT });
    expect(signedRefs.slice(1)).toEqual([{ refs: [{ item_id: row.id, version: 8 }], as: ME }, { refs: [{ item_id: row.id, version: 8 }], as: AGENT }]);
  });

  it('a host that fetches stored bytes its own way (the desktop: Chromium’s, with its disk cache) is the one used', async () => {
    const fetched: string[] = [];
    const own = cloudBackedFiles(new Uint8Array([4, 5]), async (url) => {
      fetched.push(String(url));
      return new Response(new Uint8Array([4, 5]));
    });
    row = { ...row, id: '66666666-6666-4666-8666-666666666666' };
    expect(new Uint8Array((await own.open(surface(), { ref: { id: row.id as string } })).bytes!)).toEqual(new Uint8Array([4, 5]));
    expect(fetched).toEqual([CDN]);
  });

  it('a file from before the switch (it has a pointer) uses the same file provider — one way for every file (#7290 收尾)', async () => {
    row = { ...row, pointer: `${CHAT}/${ME}/x-report.pdf` };
    const source = await files.downloadSource(surface(), { ref: { id: ITEM } });
    expect(source).toMatchObject({ name: 'report.pdf', kind: 'file', file: { purpose: 'file', revision: { item_id: ITEM, version: 2 } } });
    expect(source).not.toHaveProperty('url');
    if (source.kind === 'file') await source.file.dispose();
    expect(signedRefs).toEqual([{ refs: [{ item_id: ITEM, version: 2 }], as: ME }]);
    expect(storageSigned, 'the storage bucket is never signed directly any more').toEqual([]);
  });
});
