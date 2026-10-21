import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G1: an agent that edits a .pptx could only save a second copy — the App's upload is always a new file (`upsert: false`,
 * `version: 1`), and so is the folder App's edit(item_id, path) for an agent. `files.replace(entry, blob, { expectedVersion })` makes the content the same
 * file's next version — #7290 gugu-3: the bytes go to OSS (attachments/upload) and the server makes them the next version
 * (attachments/place → file_replace_as, one path for every writer), which keeps the old one as history and hands back the
 * old bucket copies that fell off the 50 kept, for those to be removed here. The attachments function and the database are
 * fakes in memory; the server's own rules are judged against a real database in gugu-supabase's filePlaceInFolder.test.ts.
 */

type Row = Record<string, unknown>;
const rows: Row[] = [];
const versions: Row[] = [];
const stored = new Map<string, Uint8Array>();
const removed: string[] = [];
const rpcs: { name: string; args: Row }[] = [];
let placeError: Error | null = null;
let pruned: string[] = [];
let removeError: string | null = null;
const warned: { message: string; data?: Row }[] = [];

/** The calls that write: what "refused before a byte goes" counts (reading the file first is not writing it). */
const writes = () => rpcs.filter((call) => call.name === 'place');
/** A row as the doors answer it: its place said. */
const placed = (row: Row) => ({ ...row, parent_id: null, system_role: null, path: row.filename });

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    rpc: async (name: string, args: Row) => {
      // Who may delete what is the folder's to say; here, everyone may delete everything.
      if (name === 'workspace_deletable_as') return { data: args.p_item_ids, error: null };
      rpcs.push({ name, args });
      const row = rows.find((candidate) => candidate.id === args.p_item_id)!;
      // A read (the person's or an agent's) answers with the row as it is; only the replacement makes a version.
      if (name === 'workspace_get_as') return { data: [placed(row)], error: null };
      if (name === 'workspace_versions_as') return { data: versions.filter((version) => version.item_id === row.id), error: null };
      if (name === 'workspace_delete_as') return (rows.splice(rows.indexOf(row), 1), { data: [row], error: null });
      return { data: null, error: { message: `no fake for ${name}` } };
    },
    storage: {
      from: () => ({
        upload: async (pointer: string, bytes: Uint8Array) => (stored.set(pointer, bytes), { error: null }),
        remove: async (pointers: string[]) => (removeError ? { error: { message: removeError } } : (removed.push(...pointers), { error: null })),
      }),
    },
  }),
}));

// The attachments function, as core's client reaches it: upload keeps the bytes under a staging key; place makes them the next version.
vi.mock('@gugu/core/cloud/attachmentsApi', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configuredEndpoint: (token: string) => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token }),
  uploadAttachmentBytes: async (_endpoint: unknown, file: { bytes: Uint8Array }) => {
    const key = `staging/${ME}/${randomUUID()}`;
    stored.set(key, file.bytes);
    return key;
  },
  placeAttachment: async (_endpoint: unknown, args: Row) => {
    rpcs.push({ name: 'place', args });
    if (placeError) throw placeError;
    const row = rows.find((candidate) => candidate.id === args.item_id)!;
    versions.push({ item_id: row.id, n: (row.version as number) + 1, staging: args.staging_key });
    Object.assign(row, { pointer: null, size_bytes: stored.get(args.staging_key as string)!.byteLength, content_type: args.content_type, version: (row.version as number) + 1 });
    return { ...placed(row), pruned_pointers: pruned };
  },
}));

const { createAppFiles } = await import('./app-files-core');
const { AttachmentsError } = await import('@gugu/core/cloud/attachmentsApi');
const { bridgeFailure } = await import('./bridge-protocol');

const CHAT = '33333333-3333-4333-8333-333333333333';
const ME = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const can = { write: true };
const files = createAppFiles({
  account: async () => ({ token: 'token', userId: ME }),
  hasCapability: (_id, capability) => capability === 'files:read' || can.write,
  sync: { pageFor: () => ({}), grant: () => undefined, revoke: () => undefined, ungrant: () => undefined } as never,
  identities: async () => [],
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: (message, data) => void warned.push({ message, data }),
});
const surface = (extra: Row = {}) => ({ pageId: 1, extensionId: 'workspace', itemId: null, ...extra }) as never;
const blobOf = (bytes: number[]) => ({ name: '', contentType: 'application/octet-stream', bytes: new Uint8Array(bytes).buffer as ArrayBuffer });

function stage(kind: 'file' | 'document'): Row {
  const row = {
    id: randomUUID(),
    chat_id: CHAT,
    kind,
    filename: kind === 'file' ? 'deck.pptx' : 'notes.md',
    content_type: kind === 'file' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'text/markdown',
    size_bytes: 3,
    pointer: kind === 'file' ? `${CHAT}/${ME}/old-deck.pptx` : null,
    created_by: ME,
    created_at: null,
    updated_at: null,
    source_message_ids: [],
    version: 1,
    epoch: 0,
  };
  rows.push(row);
  return row;
}

beforeEach(() => {
  rows.length = 0;
  versions.length = 0;
  stored.clear();
  removed.length = 0;
  rpcs.length = 0;
  placeError = null;
  pruned = [];
  removeError = null;
  warned.length = 0;
  can.write = true;
});

describe('files.replace: a stored file\'s next version (G1)', () => {
  it('the same entry comes back with the new bytes behind it; the RPC is told who writes it (the person here)', async () => {
    const row = stage('file');
    const entry = await files.replace(surface(), { ref: { chat: CHAT, id: row.id as string }, file: blobOf([4, 5, 6, 7]), expectedVersion: 1 });
    expect(entry).toMatchObject({ id: row.id, name: 'deck.pptx', size: 4 });
    expect(writes()).toEqual([
      { name: 'place', args: { staging_key: expect.any(String), item_id: row.id, expected_version: 1, as_user_id: ME, content_type: 'application/octet-stream' } },
    ]);
    expect([...stored.get(writes()[0]!.args.staging_key as string)!]).toEqual([4, 5, 6, 7]);
    expect(removed).toEqual([]);
  });

  it('an App\'s program acting for an agent: the agent is who writes it', async () => {
    const row = stage('file');
    const next = await files.replace(surface({ itemId: row.id, asAgent: AGENT }), { ref: { id: row.id as string }, file: blobOf([1]), expectedVersion: 1 });
    // read through the agent's door, then replaced as the agent
    expect(rpcs.map((call) => [call.name, call.args.p_as_user_id ?? call.args.as_user_id])).toEqual([['workspace_get_as', AGENT], ['place', AGENT]]);
    expect(next.version).toBe(2);
  });

  it('versions past the 50 kept: their bytes are removed here', async () => {
    const row = stage('file');
    pruned = [`${CHAT}/${ME}/v1.pptx`, `${CHAT}/someone/v2.pptx`];
    await files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([1]), expectedVersion: 1 });
    expect(removed).toEqual(pruned);
  });

  it('the server refuses (not a member, say): the refusal keeps its code; the upload is nobody\'s and expires (nothing to take back here)', async () => {
    const row = stage('file');
    placeError = new AttachmentsError('place', 403, 'denied', 'workspace item x: 22222222 is not a chat you are a member of');
    await expect(files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([1]), expectedVersion: 1 })).rejects.toMatchObject({
      code: 'denied',
      message: expect.stringMatching(/deck\.pptx was not replaced: .*not a chat you are a member of/),
    });
    expect(removed).toEqual([]);
    // The folder's own refusals come through as the database's hint, read as every door's.
    placeError = new AttachmentsError('place', 400, 'workspace_not_member', 'workspace item x: 22222222 is not a chat you are a member of');
    await expect(files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([3]), expectedVersion: 1 })).rejects.toMatchObject({ code: 'denied' });
    placeError = new AttachmentsError('place', 400, 'workspace_item_not_found', 'workspace item x not found');
    await expect(files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([4]), expectedVersion: 1 })).rejects.toMatchObject({ code: 'not-found' });
    // An upload the function no longer has is this side's failure, not a missing file.
    placeError = new AttachmentsError('place', 404, 'upload_not_found', 'upload staging/u/x was not found');
    await expect(files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([5]), expectedVersion: 1 })).rejects.toMatchObject({ code: 'failed' });
    // Control: a code the folder does not know is failed.
    placeError = new AttachmentsError('place', 500, 'something_else', 'it broke');
    await expect(files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([2]), expectedVersion: 1 })).rejects.toMatchObject({ code: 'failed' });
  });

  it('expectedVersion (A2 评审 S3; needed since 10-13): goes to the RPC; the entry says its version; replaced since ⇒ content-changed, saying the version it is now; left out ⇒ invalid', async () => {
    const row = stage('file');
    const next = await files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([1]), expectedVersion: 1 });
    expect(rpcs.at(-1)!.args.expected_version).toBe(1);
    expect(next.version).toBe(2);
    // the server's own refusal (409 version_conflict; its wording is judged against the real database in gugu-supabase's filePlaceInFolder)
    placeError = new AttachmentsError('place', 409, 'version_conflict', `workspace item ${row.id as string} version conflict: expected 2, got 3`);
    const conflict = await files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([2]), expectedVersion: 2 }).catch((error: unknown) => error);
    expect(conflict).toMatchObject({ code: 'content-changed', message: expect.stringMatching(/deck\.pptx is version 3 now, not 2: .*read it again/) });
    // and it stays content-changed across the bridge to the page or program that asked (the mac1 A/B read 'failed' there)
    expect(bridgeFailure(conflict)).toMatchObject({ code: 'content-changed', detail: { reason: 'replaced-since', now: 3, expected: 2 } });
    expect(removed).toHaveLength(0); // the upload that did not become a version expires on its own
    placeError = null;
    // left out (10-13): refused before a byte goes — a replacement that does not say what it replaces wipes another's change
    const before = writes().length;
    const bytesBefore = stored.size;
    await expect(files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([3]) })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/needs the version you started from: the entry's version/),
    });
    await expect(files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([3]), expectedVersion: null })).rejects.toMatchObject({ code: 'invalid' });
    expect(writes()).toHaveLength(before);
    expect(stored.size).toBe(bytesBefore);
    // not a version at all: refused before a byte goes
    await expect(files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([4]), expectedVersion: 1.5 })).rejects.toMatchObject({ code: 'invalid' });
    expect(writes()).toHaveLength(before);
  });

  it('a version the file is no longer at: refused before a byte goes (review 10-13)', async () => {
    const row = stage('file');
    row.version = 3; // replaced twice since this page read it at 1
    await expect(files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([1]), expectedVersion: 1 })).rejects.toMatchObject({
      code: 'content-changed',
      message: expect.stringMatching(/deck\.pptx is version 3 now, not 1: .*read it again/),
    });
    expect(writes()).toHaveLength(0);
    expect(stored.size).toBe(0);
  });



  it('refused before a byte goes: a live text file, another file without files:write, too large', async () => {
    const doc = stage('document');
    await expect(files.replace(surface(), { ref: { id: doc.id as string }, file: blobOf([1]), expectedVersion: 1 })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/live text file: change it through files\.open/),
    });
    const row = stage('file');
    can.write = false;
    await expect(files.replace(surface(), { ref: { id: row.id as string }, file: blobOf([1]), expectedVersion: 1 })).rejects.toMatchObject({ code: 'denied' });
    // Control: the file this page was opened for needs no capability.
    await expect(files.replace(surface({ itemId: row.id }), { ref: { id: row.id as string }, file: blobOf([1]), expectedVersion: 1 })).resolves.toMatchObject({ id: row.id });
    can.write = true;
    const huge = { name: '', contentType: '', bytes: new ArrayBuffer(25 * 1024 * 1024 + 1) };
    await expect(files.replace(surface(), { ref: { id: row.id as string }, file: huge, expectedVersion: 2 })).rejects.toMatchObject({ code: 'too-large' });
    expect(writes()).toHaveLength(1);
  });
});

describe('files.remove takes a stored file\'s earlier versions\' bytes with it', () => {
  it('the row goes, then its own bytes and every kept version\'s', async () => {
    const row = stage('file');
    versions.push({ item_id: row.id, n: 1, pointer: `${CHAT}/${ME}/v1.pptx` }, { item_id: row.id, n: 2, pointer: row.pointer });
    await files.remove(surface(), { ref: { id: row.id as string } });
    expect(rows).toEqual([]);
    expect(removed.sort()).toEqual([`${CHAT}/${ME}/v1.pptx`, row.pointer].sort());
  });
});
