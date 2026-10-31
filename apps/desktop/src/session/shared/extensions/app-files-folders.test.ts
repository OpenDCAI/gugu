import { rpcQuery } from '../../../../../../tests/helpers/rpcQuery';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 子文件夹 (gugu-supabase 20261016012659): a chat's folder has
 * folders — rows of kind 'folder' that other rows point at with `parent_id`. What the host answers a page or a program:
 *   · every entry says where it is (`parentId`, `path` from the top, `systemRole`); a folder is `type: 'folder'`, no App claims it;
 *   · `files.list({ chat, folder })` is what is directly in that folder (path, case not counted, or id; '' the top), and a
 *     file named by its path is found, the way the database finds them (`workspace_list_as` → `workspace_folder_for`) —
 *     the person's as the agent's; a folder never opens or saves as a file;
 *   · create / upload / mkdir / move go through the folder's doors (`workspace_mkdir_as`, `workspace_move_as`) as the
 *     person or the agent; a folder is deleted with all in it through `workspace_delete_as`, the bytes behind it after;
 *   · the folder's own refusals come back in the codes an App branches on (`name-taken`, `denied`, `not-found`).
 */

const PERSON = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';
const F = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const G = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ATT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

type Row = Record<string, unknown> & { id: string };
const base = { chat_id: CHAT, size_bytes: 1, created_at: null, updated_at: null, created_by: PERSON, source_message_ids: [], version: 1, epoch: 0, system_role: null };
// `name_key` is the database's generated lower(filename) (20261016012659): what a path is matched by.
const folder = (id: string, filename: string, parent: string | null, extra: Record<string, unknown> = {}): Row =>
  ({ ...base, id, kind: 'folder', filename, name_key: filename.toLowerCase(), content_type: 'inode/directory', pointer: null, parent_id: parent, ...extra });
const file = (id: string, filename: string, parent: string | null, extra: Record<string, unknown> = {}): Row =>
  ({ ...base, id, kind: 'file', filename, name_key: filename.toLowerCase(), content_type: 'image/png', pointer: `${CHAT}/${PERSON}/x-${filename}`, parent_id: parent, ...extra });

let rows: Row[] = [];
let versions: { item_id: string; pointer: string | null }[] = [];
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
const removed: string[][] = [];
let rpcAnswer: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
// What the database stores a picked name as, when that is not the name itself lowercased (its rule — 20261016035700 — is
// the database's: staged here per case, never worked out by this fake).
let storedAs: Record<string, string> = {};
// What the server's attachments/place named a stored file it made (its 「 (n)」), and the rows it made.
let insertedAs: Record<string, string> = {};
const inserted: Row[] = [];
// What the host logged (platform.warn): what went wrong without failing the call.
const warned: unknown[][] = [];

// The database's own lookup (workspace_folder_for): '' the top, an id, or a path folder by folder — names as it keeps them,
// case not counted, 「附件」 at the top by its role. Not there: undefined.
function folderFor(folder: string): string | null | undefined {
  const at = folder.replace(/^\/+|\/+$/g, '');
  if (!at) return null;
  if (rows.some((r) => r.id === at && r.kind === 'folder')) return at;
  let parent: string | null = null;
  for (const part of at.split('/').map((p) => p.trim())) {
    const next: Row | undefined = parent === null && part === '附件'
      ? rows.find((r) => r.system_role === 'attachments')
      : rows.find((r) => r.kind === 'folder' && (r.parent_id ?? null) === parent && String(r.name_key) === part.toLowerCase());
    if (!next) return undefined;
    parent = next.id;
  }
  return parent;
}
const pathOfRow = (r: Row): string => {
  const names = [String(r.filename)];
  for (let at = (r.parent_id as string | null) ?? null; at; ) {
    const up = rows.find((x) => x.id === at)!;
    names.unshift(String(up.filename));
    at = (up.parent_id as string | null) ?? null;
  }
  return names.join('/');
};
/** `workspace_list_as` as the database answers it (20261016012659): rows with their paths, no epoch. */
function listAs(args: Record<string, unknown>): { data: unknown; error: { message: string; hint?: string } | null } {
  let hit = rows.filter((r) => r.chat_id === args.p_chat_id);
  if (args.p_folder !== undefined && args.p_folder !== null) {
    const parent = folderFor(String(args.p_folder));
    if (parent === undefined) return { data: null, error: { message: `找不到文件夹「${String(args.p_folder)}」`, hint: 'workspace_folder_not_found' } };
    hit = hit.filter((r) => (r.parent_id ?? null) === parent);
  }
  if (typeof args.p_name === 'string' && args.p_exact === true) hit = hit.filter((r) => r.name_key === (storedAs[String(args.p_name)] ?? String(args.p_name)).toLowerCase());
  else if (typeof args.p_name === 'string') hit = hit.filter((r) => String(r.filename).toLowerCase().includes(String(args.p_name).toLowerCase()));
  if (typeof args.p_kind === 'string') hit = hit.filter((r) => r.kind === args.p_kind);
  return { data: hit.map(({ epoch: _epoch, ...r }) => ({ ...r, path: pathOfRow(r as Row) })), error: null };
}
const SHOT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** The folder's doors as the database answers them, as whoever acts: get, list, a move or rename in place, kept versions. */
function door(name: string, args: Record<string, unknown>): { data: unknown; error: { message: string; hint?: string } | null } {
  if (name === 'workspace_list_as') return listAs(args);
  const row = rows.find((r) => r.id === args.p_item_id);
  if (!row) return { data: null, error: { message: `workspace item not found: ${String(args.p_item_id)}`, hint: 'workspace_item_not_found' } };
  if (name === 'workspace_get_as') return { data: [{ ...row, path: pathOfRow(row) }], error: null };
  if (name === 'workspace_versions_as') return { data: versions.filter((v) => v.item_id === row.id).map((v, i) => ({ n: i + 1, pointer: v.pointer })), error: null };
  if (name === 'workspace_move_as') {
    // The folder's refusals as the door raises them: a sentence for people, the code in `hint` (20261016012659).
    if (row.system_role) return { data: null, error: { message: '「附件」是系统文件夹,不能改名、移动或删除;里面的文件照常管', hint: 'workspace_system_folder' } };
    if (typeof args.p_name === 'string' && /^taken/.test(args.p_name)) return { data: null, error: { message: `这个文件夹里已经有「${args.p_name}」了`, hint: 'workspace_name_taken' } };
    if (args.p_folder !== null) row.parent_id = folderFor(String(args.p_folder)) ?? null;
    if (typeof args.p_name === 'string') Object.assign(row, { filename: args.p_name, name_key: args.p_name.toLowerCase(), version: Number(row.version) + 1 });
    return { data: [{ ...row, path: pathOfRow(row) }], error: null };
  }
  return { data: null, error: { message: `no answer staged for ${name}` } };
}

/** The table is never read or written directly: everything goes through the doors. */
function table(name: string): never {
  throw new Error(`${name} was read or written directly, not through its door`);
}

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: table,
    rpc: rpcQuery(async (name: string, args: Record<string, unknown>) => {
      // Who may delete what is the folder's to say; here, everyone may delete everything.
      if (name === 'workspace_deletable_as') return { data: args.p_item_ids, error: null };
      rpcCalls.push({ name, args });
      return rpcAnswer(name, args);
    }),
    storage: {
      from: () => ({
        remove: async (list: string[]) => (removed.push(list), { data: list, error: null }),
        upload: async (path: string) => ({ data: { path }, error: null }),
      }),
    },
  }),
}));

// #7290 gugu-3: a stored file's bytes go to OSS (attachments/upload) and the server makes its row (attachments/place) —
// the row the database would make, under the name it gives it (insertedAs), as the direct insert did before.
vi.mock('@gugu/core/cloud/attachmentsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gugu/core/cloud/attachmentsApi')>()),
  configuredEndpoint: (token: string) => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token }),
  uploadAttachmentBytes: async () => 'staging/fixture',
  placeAttachment: async (_endpoint: unknown, args: { file_name: string; chat_id: string; as_user_id?: string | null; content_type?: string; keep?: string }) => {
    placed.push(args);
    const filename = insertedAs[args.file_name] ?? args.file_name;
    const row: Row = { ...base, chat_id: args.chat_id, kind: 'file', content_type: args.content_type ?? null, parent_id: null, pointer: null, filename, name_key: filename.toLowerCase(), created_by: args.as_user_id ?? PERSON,
      id: `0000000${inserted.length}-0000-4000-8000-000000000000` };
    inserted.push(row);
    rows.push(row);
    return row;
  },
}));

const placed: { keep?: string }[] = [];
const { createAppFiles } = await import('./app-files-core');

const files = createAppFiles({
  account: async () => ({ token: 'token', userId: PERSON }),
  hasCapability: () => true,
  sync: { ensureFor: () => undefined, pageFor: () => ({}), grant: () => undefined, revoke: () => undefined, ungrant: () => undefined } as never,
  // Every name is claimed by some App here: a folder still says no App opens it.
  claimant: () => ({ suffix: '.png', app: { id: 'viewer', name: 'Viewer', icon: null } }),
  identities: async (_token, ids) => ids.map((id) => ({ id, name: id === AGENT ? 'Helper' : 'Pat', avatar: null, kind: id === AGENT ? ('agent' as const) : ('human' as const) })),
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: (...args) => void warned.push(args),
});
const person = { pageId: -1, extensionId: 'workspace', itemId: null };
const asAgent = { ...person, asAgent: AGENT };

beforeEach(() => {
  rows = [folder(F, 'Docs', null), folder(G, '2026', F), file(A, 'scan.png', G), file(B, 'b.png', null), folder(ATT, '附件', null, { system_role: 'attachments', created_by: null })];
  versions = [];
  rpcCalls.length = 0;
  removed.length = 0;
  warned.length = 0;
  storedAs = {};
  insertedAs = {};
  inserted.length = 0;
  rpcAnswer = door;
});

describe('entries say where they are', () => {
  it('a person\'s list: paths from the top, folders typed folder and claimed by no App, 「附件」 by its role', async () => {
    const entries = await files.groupFiles(CHAT);
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
    expect(byId[A]).toMatchObject({ path: 'Docs/2026/scan.png', parentId: G, type: 'binary', systemRole: null });
    expect(byId[A]!.claimedBy).toMatchObject({ id: 'viewer' });
    expect(byId[G]).toMatchObject({ path: 'Docs/2026', parentId: F, type: 'folder', suffix: '', claimedBy: null, displayName: '2026' });
    expect(byId[B]).toMatchObject({ path: 'b.png', parentId: null });
    expect(byId[ATT]).toMatchObject({ type: 'folder', systemRole: 'attachments', createdBy: { kind: 'system' } });
    // One list through the door, as the person: each row says its path.
    expect(rpcCalls).toEqual([{ name: 'workspace_list_as', args: { p_chat_id: CHAT, p_as_user_id: PERSON } }]);
  });

  it('files.list({ chat, folder }): what is directly in it — by path (case not counted), by id, \'\' the top; a folder not there is not-found', async () => {
    expect((await files.groupFiles(CHAT, { folder: 'docs/2026' })).map((entry) => entry.id)).toEqual([A]);
    // Found the way the database finds it, as the person — the same door an agent's list takes.
    expect(rpcCalls[0]).toEqual({ name: 'workspace_list_as', args: { p_chat_id: CHAT, p_as_user_id: PERSON, p_folder: 'docs/2026' } });
    expect((await files.groupFiles(CHAT, { folder: F })).map((entry) => entry.id)).toEqual([G]);
    expect((await files.groupFiles(CHAT, { folder: '' })).map((entry) => entry.id).sort()).toEqual([B, F, ATT].sort());
    await expect(files.groupFiles(CHAT, { folder: 'Docs/nope' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('a file read on its own says its path as its door answers it: no read of the folders', async () => {
    const { entries } = await files.groupEntries(CHAT, [A]);
    expect(entries).toEqual([expect.objectContaining({ id: A, path: 'Docs/2026/scan.png' })]);
    expect(rpcCalls.map((call) => call.name)).toEqual(['workspace_get_as']);
  });
});

describe('a file named by its path', () => {
  it('is found the way the database finds it (workspace_list_as as the person, case not counted), and renamed where it is: its path keeps its folders', async () => {
    const renamed = await files.rename(person, { ref: { chat: CHAT, name: 'DOCS/2026/Scan.PNG' }, name: 'final.png' });
    expect(renamed).toMatchObject({ id: A, name: 'final.png', path: 'Docs/2026/final.png', parentId: G });
    expect(rpcCalls[0]).toEqual({ name: 'workspace_list_as', args: { p_chat_id: CHAT, p_as_user_id: PERSON, p_name: 'Scan.PNG', p_folder: 'DOCS/2026', p_exact: true } });
    // Negative control: the same name at the top is a different file (or none).
    await expect(files.rename(person, { ref: { chat: CHAT, name: 'scan.png' }, name: 'x.png' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('a rename to a name the folder has is name-taken; 「附件」 keeps its name (denied)', async () => {
    await expect(files.rename(person, { ref: { id: A }, name: 'taken.png' })).rejects.toMatchObject({ code: 'name-taken' });
    await expect(files.rename(person, { ref: { id: ATT }, name: 'Mine' })).rejects.toMatchObject({ code: 'denied' });
  });

  it('the code comes from the hint, not the sentence: the same sentence without a hint is only failed', async () => {
    rpcAnswer = (name, args) => name === 'workspace_move_as'
      ? { data: null, error: { message: '找不到文件夹「nope」', hint: 'workspace_folder_not_found' } }
      : door(name, args);
    await expect(files.move(person, { ref: { id: A }, folder: 'nope' })).rejects.toMatchObject({ code: 'not-found', message: '找不到文件夹「nope」' });
    rpcAnswer = (name, args) => name === 'workspace_move_as' ? { data: null, error: { message: '找不到文件夹「nope」' } } : door(name, args);
    await expect(files.move(person, { ref: { id: A }, folder: 'nope' })).rejects.toMatchObject({ code: 'failed' });
  });

  it('「附件」 at the top is the database\'s to find (by its role, the name kept for it): the path goes to its door as it is', async () => {
    rows.push(file(SHOT, 'shot.png', ATT));
    const renamed = await files.rename(person, { ref: { chat: CHAT, name: '附件/shot.png' }, name: 'kept.png' });
    expect(renamed).toMatchObject({ path: '附件/kept.png', parentId: ATT });
    expect(rpcCalls[0]!.args).toMatchObject({ p_folder: '附件', p_name: 'shot.png', p_as_user_id: PERSON, p_exact: true });
  });

  it('a folder is listed, never opened or saved as a file', async () => {
    await expect(files.open(person, { ref: { id: G } })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/2026 is a folder/) });
    await expect(files.downloadSource(person, { ref: { id: G } })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a rename is a move in place, the person\'s as an agent\'s: the door says where it is', async () => {
    const renamed = await files.rename(asAgent, { ref: { id: A }, name: 'v2.png' });
    expect(renamed).toMatchObject({ path: 'Docs/2026/v2.png', parentId: G });
    expect(rpcCalls.map((call) => call.name)).toEqual(['workspace_get_as', 'workspace_move_as']);
    expect(rpcCalls[1]!.args).toEqual({ p_item_id: A, p_as_user_id: AGENT, p_folder: null, p_name: 'v2.png' });
  });
});

describe('making, moving, deleting', () => {
  it('create into a folder as the agent: the folder through mkdir (as the agent), then the file into it by id', async () => {
    rpcAnswer = (name, args) =>
      name === 'workspace_mkdir_as'
        ? { data: [{ ...folder(G, '2026', F), path: 'Docs/2026' }], error: null }
        : { data: [{ ...base, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'document', filename: String(args.p_title), content_type: 'text/markdown', pointer: null, parent_id: G, path: 'Docs/2026/plan.md', created_by: AGENT }], error: null };
    const made = await files.create(CHAT, { name: 'plan.md', content: '', folder: 'Docs/2026' }, { asAgent: AGENT });
    expect(made).toMatchObject({ path: 'Docs/2026/plan.md', parentId: G });
    expect(rpcCalls.map((call) => call.name)).toEqual(['workspace_mkdir_as', 'workspace_create_document_as']);
    expect(rpcCalls[0]!.args).toEqual({ p_chat_id: CHAT, p_as_user_id: AGENT, p_path: 'Docs/2026' });
    expect(rpcCalls[1]!.args).toMatchObject({ p_folder: G, p_as_user_id: AGENT });
    // Negative control: no folder said — no mkdir, the top.
    rpcCalls.length = 0;
    await files.create(CHAT, { name: 'top.md', content: '' }, { asAgent: AGENT });
    expect(rpcCalls.map((call) => call.name)).toEqual(['workspace_create_document_as']);
    expect(rpcCalls[0]!.args).toMatchObject({ p_folder: null });
    await expect(files.create(CHAT, { name: 'x.md', content: '', folder: 5 }, { asAgent: AGENT })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('mkdir and move go through the doors as the person; a move needs a folder or a name; the door\'s refusal keeps its code', async () => {
    rpcAnswer = (name, args) => {
      if (name === 'workspace_mkdir_as') return { data: [{ ...folder('99999999-9999-4999-8999-999999999999', 'New', null), path: 'New' }], error: null };
      if (args.p_folder === 'Full') return { data: null, error: { message: '这个文件夹里已经有「scan.png」了', hint: 'workspace_name_taken' } };
      return { data: [{ ...file(A, 'scan.png', null), path: 'scan.png' }], error: null };
    };
    expect(await files.mkdir(CHAT, { path: 'New' })).toMatchObject({ type: 'folder', path: 'New' });
    expect(rpcCalls[0]).toEqual({ name: 'workspace_mkdir_as', args: { p_chat_id: CHAT, p_as_user_id: PERSON, p_path: 'New' } });
    await expect(files.mkdir(CHAT, { path: '  ' })).rejects.toMatchObject({ code: 'invalid' });

    expect(await files.move(person, { ref: { id: A }, folder: '' })).toMatchObject({ path: 'scan.png', parentId: null });
    expect(rpcCalls.at(-1)).toEqual({ name: 'workspace_move_as', args: { p_item_id: A, p_as_user_id: PERSON, p_folder: '', p_name: null } });
    await expect(files.move(person, { ref: { id: A }, folder: 'Full' })).rejects.toMatchObject({ code: 'name-taken' });
    await expect(files.move(person, { ref: { id: A } })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a folder goes with all in it through workspace_delete_as; the bytes behind the stored files it deleted, and their versions, after', async () => {
    versions = [{ item_id: A, pointer: `${CHAT}/${PERSON}/old-scan.png` }];
    rpcAnswer = (name, args) => name === 'workspace_delete_as'
      ? { data: [{ id: F, kind: 'folder', pointer: null }, { id: G, kind: 'folder', pointer: null }, { id: A, kind: 'file', pointer: `${CHAT}/${PERSON}/x-scan.png` }], error: null }
      : door(name, args);
    await files.remove(person, { ref: { id: F } });
    // Read first as the person (the folder, what is in it, the kept versions of the stored file in it), then the door deletes.
    expect(rpcCalls.map((call) => call.name)).toEqual(['workspace_get_as', 'workspace_list_as', 'workspace_versions_as', 'workspace_delete_as']);
    expect(rpcCalls.at(-1)).toEqual({ name: 'workspace_delete_as', args: { p_item_id: F, p_as_user_id: PERSON } });
    expect(removed).toEqual([[`${CHAT}/${PERSON}/x-scan.png`, `${CHAT}/${PERSON}/old-scan.png`]]);
  });

  it('a file moved out of the folder before the delete took the chat\'s lock keeps its bytes: only what the door deleted loses them', async () => {
    versions = [{ item_id: A, pointer: `${CHAT}/${PERSON}/old-scan.png` }];
    // Read with scan.png in the folder; the door deleted only the two folders (scan.png was moved to the top meanwhile).
    rpcAnswer = (name, args) => name === 'workspace_delete_as'
      ? { data: [{ id: F, kind: 'folder', pointer: null }, { id: G, kind: 'folder', pointer: null }], error: null }
      : door(name, args);
    await files.remove(person, { ref: { id: F } });
    expect(removed).toEqual([]);
  });

  it('an upload the database renamed says which file it clashed with — the database says (workspace_clash_as, the name as it was picked: an NFD name from macOS is its to match); one that kept its name, none', async () => {
    const OLD = '12121212-1212-4121-8121-121212121212';
    const NEW = '34343434-3434-4343-8343-343434343434';
    rpcAnswer = (name, args) => {
      if (name === 'workspace_status_as') return { data: [{}], error: null };
      if (name === 'workspace_list_as') return listAs(args);
      // What the database says: the NFD 「café.md」 got 「café (2).md」 next to OLD; 「photo (2).md」 kept its name.
      if (name === 'workspace_clash_as') return { data: args.p_item_id === NEW ? OLD : null, error: null };
      const renamed = args.p_title === 'cafe\u0301.md';
      return { data: [{ ...base, id: renamed ? NEW : B, kind: 'document', filename: renamed ? 'caf\u00E9 (2).md' : String(args.p_title), content_type: 'text/markdown', pointer: null, parent_id: null, path: 'x', created_by: AGENT }], error: null };
    };
    const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
    const [nfd, picked] = await files.upload(CHAT, [{ name: 'cafe\u0301.md', contentType: 'text/markdown', bytes: bytes('a') }, { name: 'photo (2).md', contentType: 'text/markdown', bytes: bytes('b') }], { asAgent: AGENT });
    expect(nfd).toMatchObject({ name: 'caf\u00E9 (2).md', clashWith: OLD });
    expect(picked).toMatchObject({ name: 'photo (2).md', clashWith: null });
    expect(rpcCalls.filter((call) => call.name === 'workspace_clash_as').map((call) => call.args)).toEqual([
      { p_item_id: NEW, p_as_user_id: AGENT, p_picked: 'cafe\u0301.md' },
      { p_item_id: B, p_as_user_id: AGENT, p_picked: 'photo (2).md' },
    ]);
  });

  it('the person\'s upload goes through the same doors as the person: what the database says is the clash, and no name is worked out here', async () => {
    const OLD = '56565656-5656-4565-8565-565656565656';
    // Picked as a joined emoji with a skin tone (woman, medium skin tone, ZWJ, laptop): the database named it with 「 (2)」 and says it clashed with OLD.
    const pickedName = '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}.png';
    insertedAs[pickedName] = '\u{1F469}\u{1F3FD}\u200D\u{1F4BB} (2).png';
    rpcAnswer = (name, args) => {
      if (name === 'workspace_status_as') return { data: [{}], error: null };
      if (name === 'workspace_clash_as') return { data: OLD, error: null };
      return door(name, args);
    };
    const [entry] = await files.upload(CHAT, [{ name: pickedName, contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer }]);
    expect(entry).toMatchObject({ name: '\u{1F469}\u{1F3FD}\u200D\u{1F4BB} (2).png', clashWith: OLD });
    expect(rpcCalls.find((call) => call.name === 'workspace_status_as')!.args).toEqual({ p_chat_id: CHAT, p_as_user_id: PERSON });
    expect(rpcCalls.filter((call) => call.name === 'workspace_clash_as').map((call) => call.args)).toEqual([
      { p_item_id: inserted[0]!.id, p_as_user_id: PERSON, p_picked: pickedName },
    ]);
  });

  it('keep travels with a stored file to the server, an unknown one is refused before a byte goes', async () => {
    rpcAnswer = (name, args) => (name === 'workspace_status_as' ? { data: [{}], error: null } : door(name, args));
    placed.length = 0;
    await files.upload(CHAT, [{ name: 'shot.png', contentType: 'image/png', bytes: new Uint8Array([1]).buffer as ArrayBuffer }], { keep: 'temporary' });
    expect(placed.at(-1)).toMatchObject({ keep: 'temporary' });
    await files.upload(CHAT, [{ name: 'kept.png', contentType: 'image/png', bytes: new Uint8Array([2]).buffer as ArrayBuffer }]);
    expect(placed.at(-1)).not.toHaveProperty('keep');
    const before = placed.length;
    await expect(files.upload(CHAT, [{ name: 'x.png', contentType: 'image/png', bytes: new Uint8Array([3]).buffer as ArrayBuffer }], { keep: 'forever' })).rejects.toMatchObject({ code: 'invalid' });
    expect(placed.length).toBe(before);
  });

  it('the database cannot say what an upload clashed with (the row gone before it was asked): the upload stands, nothing is asked, the host logs it', async () => {
    rpcAnswer = (name, args) => {
      if (name === 'workspace_status_as') return { data: [{}], error: null };
      if (name === 'workspace_clash_as') return { data: null, error: { message: 'workspace_clash: gone is not found in a chat you are a member of' } };
      return door(name, args);
    };
    const [entry] = await files.upload(CHAT, [{ name: 'shot.png', contentType: 'image/png', bytes: new Uint8Array([1]).buffer as ArrayBuffer }]);
    expect(entry).toMatchObject({ name: 'shot.png', clashWith: null });
    expect(warned).toEqual([['an upload could not be told which file it clashed with: nothing is asked',
      { item: inserted[0]!.id, error: 'workspace_clash: gone is not found in a chat you are a member of' }]]);
  });

  it('a file named by its path: the last part goes to the database as it was given, and the database matches it to a stored name (p_exact)', async () => {
    // What the database says that name is stored as (an invisible character out): scan.png, the file in Docs/2026.
    storedAs['sc\u200Ban.png'] = 'scan.png';
    const renamed = await files.rename(person, { ref: { chat: CHAT, name: 'Docs/2026/sc\u200Ban.png' }, name: 'x.png' });
    expect(renamed).toMatchObject({ id: A, name: 'x.png' });
    expect(rpcCalls[0]!.args).toMatchObject({ p_name: 'sc\u200Ban.png', p_folder: 'Docs/2026', p_exact: true });
  });

  it('a folder the person cannot empty: the door says so (denied), and no bytes go', async () => {
    rpcAnswer = (name, args) => name === 'workspace_delete_as'
      ? { data: null, error: { message: '文件夹「Docs」里有 1 项不是你(或你的 agent)建的,删不了:什么都没删', hint: 'workspace_folder_not_yours' } }
      : door(name, args);
    await expect(files.remove(person, { ref: { id: F } })).rejects.toMatchObject({ code: 'denied' });
    expect(removed).toEqual([]);
  });
});
