import { rpcQuery } from '../../../../../../tests/support/rpcQuery';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A2 / A4: a page or an App's program acting for an agent lists, makes, renames and removes a chat's files through the
 * agent's own door (`workspace_*_as`, #6492) — its membership decides, and what it makes is its own — and a new file keeps
 * the messages it came from. The person goes through the same door as themselves; the table is never read or written.
 * The database and the bucket are fakes in memory.
 */

type Row = Record<string, unknown>;
const OWNER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';
const OTHER_CHAT = '44444444-4444-4444-8444-444444444444';
const MESSAGE = '55555555-5555-4555-8555-555555555555';
const TOPIC = '66666666-6666-4666-8666-666666666666';
const OTHER_TOPIC = '77777777-7777-4777-8777-777777777777';

const rows: Row[] = [];
const versions = new Map<string, Row[]>();
/** The chats each one is in: the agent in CHAT only, the person in both. */
const chatsOf = new Map<string, Set<string>>();
/** Which door each read and write went through: `rpc <name>` (a table touched directly is `table <name>`, and fails). */
const doors: string[] = [];
const removed: string[] = [];
/** The ids the database says whoever asks may not delete. */
const undeletable = new Set<string>();

function table(name: string) {
  doors.push(`table ${name}`);
  throw new Error(`${name} was read or written directly, not through its door`);
}

const notMember = (chat: unknown) => ({ data: null, error: { message: `workspace: ${String(chat)} is not a group or topic you are a member of`, hint: 'workspace_not_member' } });
const notFound = (id: unknown) => ({ data: null, error: { message: `workspace item not found: ${String(id)}`, hint: 'workspace_item_not_found' } });
/** A row as the doors answer it: its place said (every file here is at the top), no epoch but from get_as. */
const placed = (row: Row) => ({ ...row, parent_id: null, system_role: null, path: row.filename });
const withoutEpoch = ({ epoch: _epoch, ...row }: Row) => placed(row);

/** The doors, as gugu-supabase writes them (20260929064500, 20261011011000, 20261016012659): whoever acts, their own membership, their own name. */
async function rpc(name: string, args: Row) {
  // Who may delete what is the folder's to say: here, all but the ones `undeletable` names.
  if (name === 'workspace_deletable_as') return { data: (args.p_item_ids as string[]).filter((id) => !undeletable.has(id)), error: null };
  doors.push(`rpc ${name}`);
  const actor = String(args.p_as_user_id);
  const isIn = (chat: unknown) => chatsOf.get(actor)?.has(String(chat)) ?? false;
  if (name === 'chat_facts') {
    const source = args.p_chat_id === TOPIC ? CHAT : args.p_chat_id === OTHER_TOPIC ? OTHER_CHAT : null;
    return { data: isIn(source ?? args.p_chat_id) ? [{ id: args.p_chat_id, kind: source ? 'topic' : 'group', source_chat_id: source }] : [], error: null };
  }
  const item = rows.find((row) => row.id === args.p_item_id);
  if ('p_item_id' in args && (!item || !isIn(item.chat_id))) return notFound(args.p_item_id);
  if ('p_chat_id' in args && !isIn(args.p_chat_id)) return notMember(args.p_chat_id);
  switch (name) {
    case 'workspace_list_as': {
      const named = typeof args.p_name === 'string' ? args.p_name.toLowerCase() : null;
      // p_exact (gugu-supabase#122): the name as the database keeps names — here, case not counted; else a substring.
      const hit = (row: Row) => (args.p_exact === true ? String(row.filename).toLowerCase() === named : String(row.filename).toLowerCase().includes(named!));
      const listed = rows.filter((row) => row.chat_id === args.p_chat_id && (!named || hit(row)));
      return { data: listed.map((row) => ({ ...withoutEpoch(row), total: listed.length })), error: null };
    }
    case 'workspace_get_as':
      return { data: [placed(item!)], error: null };
    case 'workspace_status_as':
      return { data: [{ total: 0, documents: 0, files: 0 }], error: null };
    case 'workspace_create_document_as': {
      const row = { id: randomUUID(), epoch: 0, chat_id: args.p_chat_id, kind: 'document', filename: args.p_title, content_type: args.p_content_type,
        pointer: null, created_by: args.p_as_user_id, version: 1, source_message_ids: args.p_source_message_ids ?? [] };
      rows.push(row);
      return { data: [withoutEpoch(row)], error: null };
    }
    case 'workspace_move_as':
      Object.assign(item!, { filename: args.p_name ?? item!.filename, version: Number(item!.version) + 1 });
      return { data: [withoutEpoch(item!)], error: null };
    case 'workspace_versions_as':
      return { data: versions.get(String(item!.id)) ?? [], error: null };
    case 'workspace_clash_as':
      // What an upload clashed with is the database's to say (gugu-supabase#122): every name here is new.
      return { data: null, error: null };
    case 'workspace_delete_as':
      // workspace_may_delete: who made it, the agent's owner's, or the person's own agent's.
      if (item!.created_by !== actor && item!.created_by !== OWNER && !(actor === OWNER && item!.created_by === AGENT)) {
        // As the door says it since the folder's migration (gugu-supabase 20261016012659): a sentence for people, the code in hint.
        return { data: null, error: { message: `「${String(item!.filename)}」不是你(或你的 agent)建的,删不了`, hint: 'workspace_item_not_yours' } };
      }
      rows.splice(rows.indexOf(item!), 1);
      return { data: [withoutEpoch(item!)], error: null };
    default:
      throw new Error(`no fake for ${name}`);
  }
}

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: table,
    rpc: rpcQuery(rpc),
    storage: {
      from: () => ({
        remove: async (pointers: string[]) => (removed.push(...pointers), { error: null }),
      }),
    },
  }),
}));

const { createAppFiles, sourceMessageIdsOf, AppFileError } = await import('./app-files-core');

const files = createAppFiles({
  account: async () => ({ token: 'token', userId: OWNER }),
  hasCapability: () => true,
  sync: { ensureFor: () => undefined, pageFor: () => ({}), grant: () => undefined, revoke: () => undefined, ungrant: () => undefined } as never,
  identities: async () => [],
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
});
const asAgent = { pageId: -1, extensionId: 'workspace', itemId: null, asAgent: AGENT } as never;
const asPerson = { pageId: -1, extensionId: 'workspace', itemId: null } as never;

function file(chat: string, filename: string, more: Row = {}): Row {
  const row = { id: randomUUID(), epoch: 3, chat_id: chat, kind: 'document', filename, content_type: 'text/markdown', size_bytes: 4, pointer: null,
    created_by: AGENT, version: 1, created_at: null, updated_at: null, source_message_ids: [], ...more };
  rows.push(row);
  return row;
}

beforeEach(() => {
  rows.length = 0;
  versions.clear();
  doors.length = 0;
  removed.length = 0;
  undeletable.clear();
  chatsOf.clear();
  chatsOf.set(AGENT, new Set([CHAT]));
  chatsOf.set(OWNER, new Set([CHAT, OTHER_CHAT]));
});

describe('A2: acting for an agent, through the agent\'s door', () => {
  it('list: what the agent sees in that chat, by its membership — never what the person sees', async () => {
    file(CHAT, 'notes.md');
    file(OTHER_CHAT, 'secret.md');
    const listed = await files.groupFiles(CHAT, { asAgent: AGENT });
    expect(listed.map((entry) => entry.name)).toEqual(['notes.md']);
    expect(doors).toEqual(['rpc workspace_list_as']);
    // A chat the person is in and the agent is not: refused, never listed as the person (the #6492 shape).
    await expect(files.groupFiles(OTHER_CHAT, { asAgent: AGENT })).rejects.toMatchObject({ code: 'denied' });
    // Control: the person lists as themselves, through the same door.
    doors.length = 0;
    expect((await files.groupFiles(OTHER_CHAT)).map((entry) => entry.name)).toEqual(['secret.md']);
    expect(doors).toEqual(['rpc workspace_list_as']);
  });

  it('rename: a move that stays in its folder (workspace_move_as), the name only — for the person too', async () => {
    const notes = file(CHAT, 'notes.md');
    file(CHAT, 'notes.md.bak');
    // Named in a chat: found through the agent's door (that name exactly), then read by its id, with its epoch.
    const renamed = await files.rename(asAgent, { ref: { chat: CHAT, name: 'notes.md' }, name: 'notes-v2.md' });
    expect(renamed).toMatchObject({ id: notes.id, name: 'notes-v2.md' });
    expect(doors).toEqual(['rpc workspace_list_as', 'rpc workspace_get_as', 'rpc workspace_move_as']);
    doors.length = 0;
    expect(await files.rename(asAgent, { ref: { id: String(notes.id) }, name: 'plan.md' })).toMatchObject({ name: 'plan.md', path: 'plan.md' });
    expect(doors).toEqual(['rpc workspace_get_as', 'rpc workspace_move_as']);
    doors.length = 0;
    const theirs = file(CHAT, 'theirs.md', { created_by: OWNER });
    await files.rename(asPerson, { ref: { id: String(theirs.id) }, name: 'mine.md' });
    expect(doors).toEqual(['rpc workspace_get_as', 'rpc workspace_move_as']);
  });

  it('remove: the door says who may delete; a stored file\'s history goes with its bytes — someone else\'s keeps both', async () => {
    const theirs = file(CHAT, 'theirs.png', { kind: 'file', pointer: `${CHAT}/x/theirs.png`, created_by: '66666666-6666-4666-8666-666666666666' });
    await expect(files.remove(asAgent, { ref: { id: String(theirs.id) } })).rejects.toMatchObject({ code: 'denied' });
    expect(removed).toEqual([]);
    const deck = file(CHAT, 'deck.pptx', { kind: 'file', pointer: `${CHAT}/${OWNER}/v2-deck.pptx` });
    versions.set(String(deck.id), [{ n: 1, pointer: `${CHAT}/${OWNER}/v1-deck.pptx` }]);
    doors.length = 0;
    await files.remove(asAgent, { ref: { id: String(deck.id) } });
    expect(doors).toEqual(['rpc workspace_get_as', 'rpc workspace_versions_as', 'rpc workspace_delete_as']);
    expect(removed.sort()).toEqual([`${CHAT}/${OWNER}/v1-deck.pptx`, `${CHAT}/${OWNER}/v2-deck.pptx`]);
    expect(rows).toEqual([theirs]);
  });

  it('create: the agent\'s file, through workspace_create_document_as, with the messages it came from (A4)', async () => {
    const made = await files.create(CHAT, { name: 'summary.md', content: '# done', sourceMessageIds: [MESSAGE] }, { asAgent: AGENT });
    expect(made).toMatchObject({ name: 'summary.md', createdBy: { id: `user:${AGENT}` }, sourceMessageIds: [MESSAGE] });
    expect(doors).toEqual(['rpc workspace_create_document_as']);
    await expect(files.create(OTHER_CHAT, { name: 'x.md', content: '' }, { asAgent: AGENT })).rejects.toMatchObject({ code: 'denied' });
  });
});

describe('A4: a new file\'s source messages', () => {
  it('the person\'s create and upload write them; the agent\'s upload passes them through its door', async () => {
    await files.create(CHAT, { name: 'a.md', content: 'x', sourceMessageIds: [MESSAGE] });
    await files.upload(CHAT, [{ name: 'b.md', bytes: new TextEncoder().encode('y').buffer as ArrayBuffer, contentType: '' }], { sourceMessageIds: [MESSAGE] });
    expect(rows.map((row) => row.source_message_ids)).toEqual([[MESSAGE], [MESSAGE]]);
    rows.length = 0;
    await files.upload(CHAT, [{ name: 'c.md', bytes: new TextEncoder().encode('z').buffer as ArrayBuffer, contentType: '' }], { asAgent: AGENT, sourceMessageIds: [MESSAGE] });
    expect(rows.map((row) => row.source_message_ids)).toEqual([[MESSAGE]]);
  });

  it('anything but message ids is refused, said how; none is none', () => {
    expect(sourceMessageIdsOf(undefined)).toEqual([]);
    expect(sourceMessageIdsOf([MESSAGE, MESSAGE])).toEqual([MESSAGE]);
    expect(() => sourceMessageIdsOf(['msg:abc'])).toThrow(AppFileError);
    expect(() => sourceMessageIdsOf(MESSAGE)).toThrow(/sourceMessageIds takes message ids/);
  });
});

// #7257: what a page hears in `files.onChanged({ chat })` — the files the account's revisions named, read once for the batch.
describe('groupEntries: the named files of a chat as list gives them, and the ids not there', () => {
  it('as the person: through the door, one file at a time; a file of another chat and an unknown id are gone, not shown', async () => {
    const notes = file(CHAT, 'notes.md', { version: 4 });
    const plan = file(CHAT, 'plan.md');
    file(CHAT, 'untouched.md');
    const elsewhere = file(OTHER_CHAT, 'secret.md');
    const missing = randomUUID();
    const read = await files.groupEntries(CHAT, [notes.id as string, plan.id as string, elsewhere.id as string, missing, notes.id as string]);
    expect(read.entries.map((entry) => [entry.name, entry.version]).sort()).toEqual([['notes.md', 4], ['plan.md', 1]]);
    expect(read.gone.sort()).toEqual([elsewhere.id as string, missing].sort());
    // Each named id once (the list is not read).
    expect(doors).toEqual([...Array(4).fill('rpc workspace_get_as'), 'rpc chat_facts']);
  });

  it('as an agent: through its door, one file at a time — what it cannot see is gone for it', async () => {
    const notes = file(CHAT, 'notes.md');
    const elsewhere = file(OTHER_CHAT, 'secret.md');
    const read = await files.groupEntries(CHAT, [notes.id as string, elsewhere.id as string], { asAgent: AGENT });
    expect(read).toMatchObject({ entries: [{ id: notes.id, name: 'notes.md' }], gone: [elsewhere.id] });
    expect(doors).toEqual(['rpc workspace_get_as', 'rpc workspace_get_as']);
  });

  it('no ids (or none that is an id): no read at all', async () => {
    expect(await files.groupEntries(CHAT, ['not-an-id'])).toEqual({ entries: [], gone: [] });
    expect(doors).toEqual([]);
  });
});

describe('topic references use the actor’s source container', () => {
  it('an explicit topic reference opens its source file; another source is still refused', async () => {
    const notes = file(CHAT, 'notes.md');
    const ref = { chat: TOPIC, id: String(notes.id) };
    expect(await files.openTarget(asPerson, { ref })).toMatchObject({ chatId: CHAT, itemId: notes.id });
    await expect(files.openTarget(asPerson, { ref: { ...ref, chat: OTHER_TOPIC } })).rejects.toMatchObject({ code: 'invalid' });
    expect(await files.groupFile(TOPIC, String(notes.id))).toMatchObject({ chatId: CHAT, itemId: notes.id });
    await expect(files.groupFile(OTHER_TOPIC, String(notes.id))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('the actor is in the source while its owner is outside: normalized file reads still act as the agent', async () => {
    chatsOf.set(OWNER, new Set());
    const notes = file(CHAT, 'agent-notes.md');
    expect(await files.openTarget(asAgent, { ref: { chat: TOPIC, id: String(notes.id) } })).toMatchObject({ chatId: CHAT });
    expect(await files.groupEntries(TOPIC, [String(notes.id)], { asAgent: AGENT })).toMatchObject({ entries: [{ chat: CHAT, id: notes.id }], gone: [] });
    await expect(files.openTarget(asPerson, { ref: { id: String(notes.id) } })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('the owner’s membership never substitutes for an agent outside the source', async () => {
    chatsOf.set(AGENT, new Set());
    const notes = file(CHAT, 'owner-notes.md');
    await expect(files.openTarget(asAgent, { ref: { chat: TOPIC, id: String(notes.id) } })).rejects.toMatchObject({ code: 'not-found' });
    expect(await files.groupEntries(TOPIC, [String(notes.id)], { asAgent: AGENT })).toEqual({ entries: [], gone: [notes.id] });
  });
});

// #7257 review 2: past so many ids (or when who opens which changed) a page hears every file of the chat — and the named
// ids not among them are still said gone: a file deleted while its id waited is not left on the page.
describe('groupChange: the named files, or every file of the chat with the named ones not there gone', () => {
  it('all: one list of the chat; a named id deleted or of another chat is gone, every file there told', async () => {
    const notes = file(CHAT, 'notes.md');
    file(CHAT, 'plan.md');
    const elsewhere = file(OTHER_CHAT, 'secret.md');
    const missing = randomUUID();
    const read = await files.groupChange(CHAT, { ids: [notes.id as string, missing, elsewhere.id as string, missing], all: true });
    expect(read.entries.map((entry) => entry.name).sort()).toEqual(['notes.md', 'plan.md']);
    expect(read.gone.sort()).toEqual([elsewhere.id as string, missing].sort());
    expect(doors).toEqual(['rpc workspace_list_as']);
  });

  it('all, as an agent: the list through its door, what it lists not among the named gone', async () => {
    const notes = file(CHAT, 'notes.md');
    const missing = randomUUID();
    const read = await files.groupChange(CHAT, { ids: [notes.id as string, missing], all: true }, { asAgent: AGENT });
    expect(read).toMatchObject({ entries: [{ id: notes.id, name: 'notes.md' }], gone: [missing] });
    expect(doors).toEqual(['rpc workspace_list_as']);
  });

  it('not all: the named files only (groupEntries) — the list is not read', async () => {
    const notes = file(CHAT, 'notes.md');
    file(CHAT, 'plan.md');
    const missing = randomUUID();
    const read = await files.groupChange(CHAT, { ids: [notes.id as string, missing], all: false });
    expect(read).toMatchObject({ entries: [{ id: notes.id, name: 'notes.md' }], gone: [missing] });
    expect(doors).toEqual(['rpc workspace_get_as', 'rpc workspace_get_as']);
  });
});

// owner 10-18: who may delete is the folder's rule (who made it, or the chat's owner or an admin); a list says it per file.
describe('canDelete: what the database says whoever reads may delete', () => {
  it('each entry says it, as the database answered for the batch', async () => {
    file(CHAT, 'mine.md');
    const theirs = file(CHAT, 'theirs.md', { created_by: '66666666-6666-4666-8666-666666666666' });
    undeletable.add(String(theirs.id));
    const listed = await files.groupFiles(CHAT, { asAgent: AGENT });
    expect(Object.fromEntries(listed.map((entry) => [entry.name, entry.canDelete]))).toEqual({ 'mine.md': true, 'theirs.md': false });
  });
});
