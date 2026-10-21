import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * S15 (统筹 10:20, 真源原则 9 / 13): which files a page may open, as main grants them — the person's own opens. Every call
 * names its file; where the page is plays no part (主人 10-05:「一开始定好权限，后面管那么多干嘛」). A file the person can
 * read, of any chat, that was not handed to the page is read-write with `files:write`, read-only with
 * `files:read` alone, and refused with neither. A file the person cannot read is `not-found` (nothing says it is
 * there); a ref naming a chat the file they can read is not in is `invalid`, said where. Neither grants anything.
 */

const PERSON = '11111111-1111-4111-8111-111111111111';
const CHAT = '33333333-3333-4333-8333-333333333333';
const OTHER_CHAT = '55555555-5555-4555-8555-555555555555';
const ITEM = '44444444-4444-4444-8444-444444444444';
const OTHER_ITEM = '66666666-6666-4666-8666-666666666666';
const rowOf = (id: string, chatId: string) => ({
  id, chat_id: chatId, kind: 'document', filename: `${id.slice(0, 4)}.md`, content_type: 'text/markdown', size_bytes: 2,
  created_at: null, updated_at: null, created_by: PERSON, source_message_ids: [], pointer: null as string | null, epoch: 1, version: 1,
});

/** What the person reads through the door, as themselves (every group they are in — this one and another). */
let personSees: ReturnType<typeof rowOf>[] = [];

async function rpc(name: string, args: Record<string, unknown>) {
  // Who may delete what is the folder's to say; here, everyone may delete everything.
  if (name === 'workspace_deletable_as') return { data: args.p_item_ids, error: null };
  if (name !== 'workspace_get_as') throw new Error(`no fake for ${name}`);
  const row = personSees.find((r) => r.id === args.p_item_id);
  if (!row) return { data: null, error: { message: `workspace item not found: ${String(args.p_item_id)}`, hint: 'workspace_item_not_found' } };
  return { data: [{ ...row, parent_id: null, system_role: null, path: row.filename }], error: null };
}

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    rpc,
  }),
}));
// A stored file's bytes are signed by attachments/urls for that item and version (#7290 收尾: the one way).
vi.mock('@gugu/core/cloud/attachmentsApi', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configuredEndpoint: (token: string) => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token }),
  fetchAttachmentUrls: async (_endpoint: unknown, refs: { item_id: string; version: number }[]) => ({
    urls: refs.map((ref) => ({ ...ref, message_id: null, url: `https://oss.test/${ref.item_id}`, thumb_url: null, sha256: null, width: null, height: null, expires_at: '2999-01-01T00:00:00Z' })),
  }),
}));

const { createAppFiles } = await import('./app-files-core');

let capabilities = new Set<string>();
const grants: unknown[] = [];
const files = createAppFiles({
  account: async () => ({ token: 'token', userId: PERSON }),
  hasCapability: (_extensionId, capability) => capabilities.has(capability),
  sync: { pageFor: () => ({}), grant: (_page: unknown, grant: unknown) => void grants.push(grant), revoke: () => undefined, ungrant: () => undefined } as never,
  identities: async () => [],
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
});
const page = { pageId: 7, extensionId: 'board', itemId: null };

beforeEach(() => {
  personSees = [rowOf(ITEM, CHAT), rowOf(OTHER_ITEM, OTHER_CHAT)];
  capabilities = new Set(['files:read', 'files:write']);
  grants.length = 0;
});

describe('a page opens the file a call names, of any chat the person is in (S15, 原则 13)', () => {
  it("another chat's file opens by the capability words alone — where the page is plays no part", async () => {
    await files.open(page, { ref: { id: OTHER_ITEM } });
    expect(grants).toEqual([{ docName: `${OTHER_ITEM}@1`, itemId: OTHER_ITEM, access: 'rw', needs: 'files:write' }]);
  });

  it('a ref whose chat and id disagree is invalid, naming where the file is; one the person cannot read is not-found; nothing is granted', async () => {
    const wrongChat = await files.open(page, { ref: { chat: CHAT, id: OTHER_ITEM } }).catch((error: unknown) => error);
    const nowhere = await files.open(page, { ref: { id: '77777777-7777-4777-8777-777777777777' } }).catch((error: unknown) => error);
    expect(wrongChat).toMatchObject({ code: 'invalid', message: `File ${OTHER_ITEM} is in chat ${OTHER_CHAT}, not ${CHAT}: pass the entry or ctx.file as it is` });
    expect(nowhere).toMatchObject({ code: 'not-found' });
    expect(grants).toEqual([]);
  });

  it('control: an entry (it carries its chat) opens, read-write with files:write', async () => {
    await files.open(page, { ref: { chat: CHAT, id: ITEM } });
    expect(grants).toEqual([{ docName: `${ITEM}@1`, itemId: ITEM, access: 'rw', needs: 'files:write' }]);
  });
});

describe('what a page may do with a file it was not handed (S15)', () => {
  it('files:read alone opens it read-only', async () => {
    capabilities = new Set(['files:read']);
    await files.open(page, { ref: { chat: CHAT, id: ITEM } });
    expect(grants).toEqual([{ docName: `${ITEM}@1`, itemId: ITEM, access: 'ro', needs: 'files:read' }]);
  });

  it('neither capability: refused, and nothing is granted', async () => {
    capabilities = new Set();
    await expect(files.open(page, { ref: { chat: CHAT, id: ITEM } })).rejects.toMatchObject({ code: 'denied' });
    expect(grants).toEqual([]);
  });

  it('control: the file handed to the page needs no capability and is read-write', async () => {
    capabilities = new Set();
    await files.open({ ...page, itemId: ITEM }, { ref: { chat: CHAT, id: ITEM } });
    expect(grants).toEqual([{ docName: `${ITEM}@1`, itemId: ITEM, access: 'rw', needs: null }]);
  });
});

describe('a stored file — an image, a clip, a sound — opens read-only, as its bytes (owner 10-07)', () => {
  const IMAGE = '88888888-8888-4888-8888-888888888888';
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const fetched: string[] = [];
  beforeEach(() => {
    personSees.push({ ...rowOf(IMAGE, CHAT), kind: 'file', filename: 'shot.png', content_type: 'image/png', size_bytes: 4, pointer: `${CHAT}/shot.png` });
    fetched.length = 0;
    vi.stubGlobal('fetch', async (url: string) => (fetched.push(url), new Response(PNG)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('even with files:write: read-only, its bytes, and nothing granted to sync', async () => {
    const opened = await files.open(page, { ref: { chat: CHAT, id: IMAGE } });
    expect(opened).toMatchObject({ docName: '', access: 'ro', entry: { name: 'shot.png', type: 'binary', contentType: 'image/png' } });
    expect([...new Uint8Array(opened.bytes!)]).toEqual([...PNG]);
    expect(fetched).toEqual([`https://oss.test/${IMAGE}`]);
    expect(grants).toEqual([]);
  });

  it("a document's gate: neither capability is refused before a byte is read; the file handed to the page needs none", async () => {
    capabilities = new Set();
    await expect(files.open(page, { ref: { chat: CHAT, id: IMAGE } })).rejects.toMatchObject({ code: 'denied' });
    expect(fetched).toEqual([]);
    expect((await files.open({ ...page, itemId: IMAGE }, { ref: { chat: CHAT, id: IMAGE } })).access).toBe('ro');
  });
});
