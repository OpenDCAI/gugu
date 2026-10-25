import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 摩擦单 F19(L7-g,S11):一份 36 KB 的看板 JSON 传进群落成 file,点开后 App 报「… is not a document that can be opened
 * for editing」。上传一个 .json 和新建一个 .json 是同一种东西 —— App 里人上传(files.upload)和 agent 的
 * 群文件夹 App 替 agent 放文件(create)问同一个判据(workspaceUploadKind)。这里判 App 这一半:上传的文本文件能被 App 打开来改,
 * 存成文件的那些只读打开、拿到的是字节(对照;10-07 前是打不开)。#7290 gugu-3:文件的字节经 attachments/upload 进 OSS,
 * attachments/place 由服务端放进文件夹(以 agent 或人的身份)。库和 attachments 函数换成内存里的假的。
 */

type Row = Record<string, unknown>;
const uploadScopes: Row[] = [];
const rows: Row[] = [];
const bucketed: string[] = [];
const stored = new Map<string, Uint8Array>();

const rpcs: { name: string; args: Row }[] = [];
const places: Row[] = [];
const stagingOfItem = new Map<string, string>();
const agentChats = new Set<string>();
const PERSON = '11111111-1111-4111-8111-111111111111';
/** A door that refuses to make a file, as the database says it (its code in `hint`). */
let refuseCreate: { message: string; hint: string } | null = null;
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    // The workspace_*_as door (G5): whoever acts, their own membership — the person is in CHAT, an agent only where
    // `agentChats` says; a row written in their name.
    rpc: async (name: string, args: Row) => {
      // Who may delete what is the folder's to say; here, everyone may delete everything.
      if (name === 'workspace_deletable_as') return { data: args.p_item_ids, error: null };
      rpcs.push({ name, args });
      // What an upload clashed with is the database's to say (gugu-supabase#122): every name here is new.
      if (name === 'workspace_clash_as') return { data: null, error: null };
      if (name === 'workspace_get_as') {
        const row = rows.find((candidate) => candidate.id === args.p_item_id);
        return row ? { data: [row], error: null } : { data: null, error: { message: `workspace item not found: ${String(args.p_item_id)}`, hint: 'workspace_item_not_found' } };
      }
      if (args.p_as_user_id !== PERSON && !agentChats.has(String(args.p_chat_id))) {
        return { data: null, error: { message: `workspace: ${args.p_chat_id} is not a chat you are a member of`, hint: 'workspace_not_member' } };
      }
      if (name === 'workspace_status_as') return { data: [{ total: 0, documents: 0, files: 0 }], error: null };
      if (refuseCreate) return { data: null, error: refuseCreate };
      const row = { id: randomUUID(), epoch: 0, chat_id: args.p_chat_id, kind: 'document', filename: args.p_title, content_type: args.p_content_type,
        inline_text: args.p_content, pointer: null, created_by: args.p_as_user_id, version: 1, created_at: null, updated_at: null, source_message_ids: [],
        parent_id: null, system_role: null, path: args.p_title };
      rows.push(row);
      return { data: [row], error: null };
    },
  }),
}));
// The attachments function: upload keeps the bytes under a staging key; place makes the file (as the server would, in the
// agent's or the person's name); urls signs an item's bytes back.
vi.mock('@gugu/core/cloud/attachmentsApi', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configuredEndpoint: (token: string) => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token }),
  uploadAttachmentBytes: async (_endpoint: unknown, file: { bytes: Uint8Array }, scope: Row) => {
    uploadScopes.push(scope);
    const key = `staging/me/${randomUUID()}`;
    bucketed.push(key);
    stored.set(key, file.bytes);
    return key;
  },
  placeAttachment: async (_endpoint: unknown, args: Row) => {
    places.push(args);
    const row = { id: randomUUID(), epoch: 0, chat_id: args.chat_id, kind: 'file', filename: args.file_name, content_type: args.content_type, pointer: null,
      created_by: args.as_user_id, created_at: null, updated_at: null, source_message_ids: args.source_message_ids, version: 1,
      parent_id: null, system_role: null, path: args.file_name };
    rows.push(row);
    stagingOfItem.set(row.id, args.staging_key as string);
    return row;
  },
  fetchAttachmentUrls: async (_endpoint: unknown, refs: { item_id: string; version: number }[]) => ({
    urls: refs.map((ref) => ({ ...ref, message_id: null, url: `https://oss.test/${stagingOfItem.get(ref.item_id)}`, thumb_url: null, sha256: null, width: null, height: null, expires_at: '2999-01-01T00:00:00Z' })),
  }),
}));

const { createAppFiles } = await import('./app-files-core');

const CHAT = '33333333-3333-4333-8333-333333333333';
const files = createAppFiles({
  account: async () => ({ token: 'token', userId: PERSON }),
  hasCapability: () => true,
  sync: { pageFor: () => ({}), grant: () => undefined, revoke: () => undefined, ungrant: () => undefined } as never,
  identities: async () => [],
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
});
const surface = { pageId: 'page-1', extensionId: 'workspace', itemId: null } as never;
const bytesOf = (text: string | Uint8Array) => {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

beforeEach(() => {
  uploadScopes.length = 0;
  rpcs.length = 0;
  places.length = 0;
  stagingOfItem.clear();
  agentChats.clear();
  refuseCreate = null;
  rows.length = 0;
  bucketed.length = 0;
  stored.clear();
});

describe('files.upload: a text file goes in as a live document (F19)', () => {
  it('a 36 KB board .json from the picker (no type given) is a document, and the App opens it for editing', async () => {
    const board = JSON.stringify({ columns: Array.from({ length: 480 }, (_, i) => ({ id: i, cards: ['x'.repeat(60)] })) });
    expect(board.length).toBeGreaterThan(36 * 1024);
    const [entry] = await files.upload(CHAT, [{ name: 'board.json', bytes: bytesOf(board), contentType: '' }]);
    expect(entry).toMatchObject({ name: 'board.json', contentType: 'application/json' });
    expect(rows[0]).toMatchObject({ kind: 'document', inline_text: board, content_type: 'application/json' });
    expect(bucketed).toEqual([]);
    const opened = await files.open(surface, { ref: entry! });
    expect(opened.access).toBe('rw');
  });

  it('G4: an HTML report (a deck, a page) goes in as a live text file too, typed text/html and named .html', async () => {
    const page = '<!doctype html><meta charset="utf-8"><main><h1>周报</h1></main>';
    const [entry] = await files.upload(CHAT, [{ name: 'report.html', bytes: bytesOf(page), contentType: '' }]);
    expect(entry).toMatchObject({ name: 'report.html', contentType: 'text/html', type: 'text', suffix: '.html' });
    expect(rows[0]).toMatchObject({ kind: 'document', inline_text: page });
    expect(bucketed).toEqual([]);
    // Control: over 1 MiB it stays bytes, as any text kind does.
    await files.upload(CHAT, [{ name: 'huge.html', bytes: bytesOf(`<p>${'y'.repeat(1024 * 1024)}</p>`), contentType: 'text/html' }]);
    expect(rows[1]).toMatchObject({ kind: 'file', content_type: 'text/html' });
  });

  it('control: over 1 MiB, not UTF-8, or an image stays a file — it opens read-only, as its bytes, never for editing', async () => {
    const uploaded = await files.upload(CHAT, [
      { name: 'huge.json', bytes: bytesOf(`{"x":"${'y'.repeat(1024 * 1024)}"}`), contentType: 'application/json' },
      { name: 'latin1.txt', bytes: bytesOf(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), contentType: 'text/plain' },
      { name: 'photo.png', bytes: bytesOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), contentType: 'image/png' },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['file', 'file', 'file']);
    expect(bucketed).toHaveLength(3);
    vi.stubGlobal('fetch', async (url: string) => new Response(stored.get(url.replace('https://oss.test/', ''))!.slice()));
    const photo = await files.open(surface, { ref: uploaded[2]! });
    vi.unstubAllGlobals();
    expect(photo).toMatchObject({ docName: '', access: 'ro', entry: { name: 'photo.png', type: 'binary' } });
    expect([...new Uint8Array(photo.bytes!)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('files.upload from an App\'s program acting for an agent (G5)', () => {
  const AGENT = '22222222-2222-4222-8222-222222222222';
  it('written in the agent\'s name through workspace_*_as, the agent\'s membership checked first', async () => {
    agentChats.add(CHAT);
    const [doc, file] = await files.upload(
      CHAT,
      [
        { name: 'notes.md', bytes: bytesOf('# hi'), contentType: '' },
        { name: 'deck.pptx', bytes: bytesOf(new Uint8Array([1, 2, 3])), contentType: 'application/octet-stream' },
      ],
      { asAgent: AGENT },
    );
    expect(rpcs.map((r) => r.name)).toEqual(['workspace_status_as', 'workspace_create_document_as', 'workspace_clash_as', 'workspace_clash_as']);
    expect(rpcs.every((r) => r.args.p_as_user_id === AGENT)).toBe(true);
    // The stored file: its bytes to OSS, the server makes it in the agent's name (attachments/place).
    expect(places).toEqual([expect.objectContaining({ chat_id: CHAT, file_name: 'deck.pptx', as_user_id: AGENT, folder: null })]);
    expect(rows.map((row) => row.created_by)).toEqual([AGENT, AGENT]);
    expect(doc).toMatchObject({ name: 'notes.md', type: 'text' });
    expect(file).toMatchObject({ name: 'deck.pptx', type: 'binary' });
    expect(bucketed).toHaveLength(1);
    expect(uploadScopes).toEqual([{ chat_id: CHAT, as: AGENT }]);
  });

  it('a chat the agent is not in: refused before a byte goes, nothing in the bucket, nothing in the table', async () => {
    await expect(
      files.upload(CHAT, [{ name: 'deck.pptx', bytes: bytesOf(new Uint8Array([1])), contentType: 'application/octet-stream' }], { asAgent: AGENT }),
    ).rejects.toMatchObject({ code: 'denied', message: expect.stringMatching(/is not a chat you are a member of/) });
    expect(bucketed).toEqual([]);
    expect(rows).toEqual([]);
    // Control: the person's own upload (no agent) goes the way it always did.
    await files.upload(CHAT, [{ name: 'deck.pptx', bytes: bytesOf(new Uint8Array([1])), contentType: 'application/octet-stream' }]);
    expect(rows[0]).toMatchObject({ created_by: '11111111-1111-4111-8111-111111111111' });
  });

  it('a file the door refuses partway: the upload stops with the door\'s code', async () => {
    refuseCreate = { message: 'workspace: 33333333 is not a chat you are a member of', hint: 'workspace_not_member' };
    await expect(files.upload(CHAT, [{ name: 'a.md', bytes: bytesOf('x'), contentType: '' }])).rejects.toMatchObject({
      code: 'denied',
      message: expect.stringMatching(/^Upload stopped at a\.md .*not uploaded: a\.md$/),
    });
    // Control: a refusal with no code the folder knows is failed.
    refuseCreate = { message: 'something else broke', hint: 'nothing_we_know' };
    await expect(files.upload(CHAT, [{ name: 'a.md', bytes: bytesOf('x'), contentType: '' }])).rejects.toMatchObject({ code: 'failed' });
  });
});
