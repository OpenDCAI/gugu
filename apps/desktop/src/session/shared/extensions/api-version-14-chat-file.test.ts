import { rpcQuery } from '../../../../../../tests/helpers/rpcQuery';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * apiVersion 14 (owner 10-24: one App's one resource is one tab, however it was opened): a tab names the file it shows
 * when its App is opened in a chat (`chatFile`), so the host finds that file before any of the App runs — made empty the
 * first time — and the App opened from the chat and that file opened from the folder are one tab. Without it the App in a
 * chat is its own page, as before: one test (does it name a file), not a second way for older Apps.
 */

const PERSON = '11111111-1111-4111-8111-111111111111';
const CHAT = '33333333-3333-4333-8333-333333333333';
const BOARD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NAME = '协作看板.board.json';

type Row = Record<string, unknown> & { id: string; filename: string; parent_id: string | null };
const base = { chat_id: CHAT, kind: 'document', content_type: 'application/json', size_bytes: 2, created_at: null, updated_at: null, created_by: PERSON, source_message_ids: [], pointer: null, version: 1, epoch: 1, system_role: null };
let rows: Row[] = [];
let calls: string[] = [];
/** Someone else's file of that name lands between this person's look and their make (the race two first opens run). */
let theirsLandsFirst = false;
let made = 0;

/** The folder's doors as the database answers them: a name it already has at the top gets 「 (2)」 on insert (20261016012659). */
function door(name: string, args: Record<string, unknown>): { data: unknown; error: { message: string; hint?: string } | null } {
  calls.push(name);
  if (name === 'workspace_list_as') {
    const hit = rows.filter((row) => row.parent_id === null && row.filename.toLowerCase() === String(args.p_name).toLowerCase());
    return { data: hit.map((row) => ({ ...row, path: row.filename })), error: null };
  }
  if (name === 'workspace_get_as') {
    const row = rows.find((candidate) => candidate.id === args.p_item_id);
    return row ? { data: [{ ...row, path: row.filename }], error: null } : { data: null, error: { message: 'not found', hint: 'workspace_item_not_found' } };
  }
  if (name === 'workspace_create_document_as') {
    if (theirsLandsFirst) rows.push({ ...base, id: BOARD, filename: String(args.p_title), parent_id: null });
    const taken = rows.some((row) => row.parent_id === null && row.filename === args.p_title);
    const row: Row = { ...base, id: `0000000${++made}-0000-4000-8000-000000000000`, filename: taken ? '协作看板 (2).board.json' : String(args.p_title), parent_id: null, content_type: String(args.p_content_type), content: args.p_content };
    rows.push(row);
    return { data: [row], error: null };
  }
  if (name === 'workspace_delete_as') {
    const gone = rows.filter((row) => row.id === args.p_item_id);
    rows = rows.filter((row) => row.id !== args.p_item_id);
    return { data: gone, error: null };
  }
  return { data: null, error: { message: `no answer staged for ${name}` } };
}

vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({ from: () => { throw new Error('read through the doors') }, rpc: rpcQuery(async (name: string, args: Record<string, unknown>) => door(name, args)) }),
}));

const { createAppFiles } = await import('./app-files-core');
const { EXTENSION_API_VERSION, safeParseExtensionManifest, parseExtensionManifest } = await import('./manifest');

const files = createAppFiles({
  account: async () => ({ token: 'token', userId: PERSON }),
  hasCapability: () => true,
  sync: { ensureFor: () => undefined, pageFor: () => ({}), grant: () => undefined, revoke: () => undefined, ungrant: () => undefined } as never,
  claimant: () => null,
  identities: async () => [],
  faces: async () => ({}),
  filesUrl: () => 'http://files.invalid',
  warn: () => undefined,
});

const app = (fileTab: Record<string, unknown>, apiVersion = 14) => ({
  id: 'kanban', name: '协作看板', version: '1.1.0', apiVersion, entry: 'board.html',
  contributes: { tabs: [{ name: 'board', title: '协作看板' }, { name: 'file', title: '协作看板', ...fileTab }] },
});
const naming = { opensFiles: { chat: ['.board.json'] }, chatFile: NAME };

beforeEach(() => {
  rows = [];
  calls = [];
  theirsLandsFirst = false;
  made = 0;
});

describe('chatFile in a manifest', () => {
  it('this build knows 14', () => {
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(14);
  });

  it('is a name this tab opens in a chat, on one tab, from apiVersion 14', () => {
    expect(safeParseExtensionManifest(app(naming)).ok).toBe(true);
    expect(safeParseExtensionManifest(app(naming, 13))).toMatchObject({ ok: false, issues: ['apiVersion: chatFile requires apiVersion 14'] });
    expect(safeParseExtensionManifest(app({ opensFiles: { chat: ['.vote.json'] }, chatFile: NAME }))).toMatchObject({ ok: false });
    expect(safeParseExtensionManifest(app({ opensFiles: { session: ['.board.json'] }, chatFile: NAME }))).toMatchObject({ ok: false });
    expect(safeParseExtensionManifest(app({ ...naming, chatFile: `boards/${NAME}` }))).toMatchObject({ ok: false });
    const twice = { ...app(naming), contributes: { tabs: [{ name: 'a', title: 'A', ...naming }, { name: 'b', title: 'B', ...naming }] } };
    expect(safeParseExtensionManifest(twice)).toMatchObject({ ok: false });
  });
});

describe('the file an App names for a chat', () => {
  it('found at the top of the chat folder, it opens as that file opened with that tab', async () => {
    rows = [{ ...base, id: BOARD, filename: NAME, parent_id: null }];
    const detail = await files.appChatFile(CHAT, parseExtensionManifest(app(naming)));
    expect(detail).toMatchObject({ chatId: CHAT, itemId: BOARD, name: NAME, choice: { kind: 'one', candidate: { tabKind: 'kanban.file', suffix: '.board.json' } } });
    expect(calls).not.toContain('workspace_create_document_as');
  });

  it('not there yet, it is made empty for the person — {} for JSON, which the App fills', async () => {
    const detail = await files.appChatFile(CHAT, parseExtensionManifest(app(naming)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filename: NAME, content: '{}', content_type: 'application/json' });
    expect(detail.itemId).toBe(rows[0]!.id);
  });

  it('two making it at once: the later one, named apart by the folder, goes again, and both open the first', async () => {
    theirsLandsFirst = true;
    const detail = await files.appChatFile(CHAT, parseExtensionManifest(app(naming)));
    expect(detail.itemId).toBe(BOARD);
    expect(rows.map((row) => row.filename)).toEqual([NAME]);
    expect(calls).toContain('workspace_delete_as');
  });

  it('an App that names none is refused, said: its own page is what opens it in a chat', async () => {
    await expect(files.appChatFile(CHAT, parseExtensionManifest(app({ opensFiles: { chat: ['.board.json'] } })))).rejects.toMatchObject({ code: 'not-found' });
    await expect(files.appChatFile(CHAT, undefined)).rejects.toMatchObject({ code: 'not-found' });
  });
});
