import { readDocumentText, ChatFolderReadError } from './chat-folder-text';
import { AttachmentsError, configuredEndpoint, fetchAttachmentUrls, placeAttachment, uploadAttachmentBytes } from '@gugu/core/cloud/attachmentsApi';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { createAttachmentResolver, type AttachmentResolver } from '@gugu/core/shared/attachmentUrls';
import { fetchInChunks } from '@gugu/core/shared/inChunks';
import { mimeTypeFromName } from '@gugu/core/shared/imageMime.mjs';
import { workspaceUploadKind } from '@gugu/core/shared/workspaceUpload.mjs';
import type { ErrorDetail, ExtensionChat } from './bridge-protocol';
import type { Grant, PageSync } from './file-sync-core';
import {
  APP_FILE_MAX_BYTES,
  fileSuffixOf,
  fileTypeOf,
  folderOf,
  personId,
  typedFileName,
  type AppFileClaimant,
  type AppFileEntry,
  type AppFileRef,
  type AppFileSearch,
  type AppFileOpened,
  type AppFilePerson,
  type AppFileUpload,
  type AppFileVersion,
  type AppFileVersionContent,
  type AppOpenWithDetail,
  type AppShowMessageDetail,
  type ChatPeekFile,
  type LocalPlace,
  type SyncRevokeReason,
} from './app-runtime-protocol';
import { fileOpenersFor } from './file-openers';
import type { ExtensionManifest } from './manifest';
import { displayNameOf } from './file-openers';

/**
 * `gugu.files` as the host answers it: which file a page means, whether it may have it, and the
 * open file grant that follows (L3-runtime-interface.md §4, 真源原则 9). The desktop answers in main;
 * the phone in the outer gugu page — same code, the platform only supplies the account, the
 * capability check and the relay (`FilesPlatform`).
 *
 * The page names a file and the chat it is in (`AppFileRef`, 真源原则 13) — never "the chat the page sits in". Two
 * kinds of open file, and only two:
 * - the file the host handed this page (`ctx.file` — the person opened that file with this App): no capability,
 *   read-write;
 * - any other file of any chat: `files:write` for read-write, `files:read` for read-only. The same two words
 *   as for a session's working copy. The consent said so once, at install; nothing asks again per chat.
 *
 * Every read and write goes through the folder's one door, `workspace_*_as`, as whoever acts — the person themselves, or
 * the agent a program works for (`asAgent`): its membership decides, so a chat they are not in has no files and says
 * `not-found`, and what it makes is theirs.
 */

/** A refusal of `gugu.files`: `code` and `detail` are what an App branches on (bridge-protocol.ts `ErrorDetail`), the message is for people. */
export class AppFileError extends Error {
  constructor(
    readonly code: 'denied' | 'invalid' | 'failed' | 'not-found' | 'ambiguous' | 'too-large' | 'content-changed' | 'name-taken',
    message: string,
    readonly detail?: ErrorDetail,
  ) {
    super(message);
  }
}

/** Who is asking about files: the page, and the one chat file it may open without a capability. */
export interface FileSurface {
  /** The page's id with the relay: its webContents on the desktop, its frame on the phone. */
  pageId: number;
  extensionId: string;
  /** The chat file the host handed this page (`ctx.file`), if any: it needs no capability. */
  itemId: string | null;
  /**
   * 摩擦单 F16 An App's program opening the file one of this person's agents handed it: the agent (a uuid) it acts
   * as — the file is read as that agent (it must be in the group itself; the person may not be) and its sync rides the
   * relay's connection acting as the agent, so the service stamps what the program writes as the agent's.
   */
  asAgent?: string | null;
}

export interface FilesPlatform {
  /** The signed-in account; throw `AppFileError('failed', …)` when there is none. */
  account(): Promise<{ token: string; userId: string }>;
  hasCapability(extensionId: string, capability: 'files:read' | 'files:write'): boolean;
  sync: {
    pageFor(pageId: number, extensionId: string): PageSync;
    grant(page: PageSync, grant: Grant): void;
    ungrant(pageId: number, docName: string): void;
    revoke(pageId: number, reason: SyncRevokeReason | null, docNames?: (grant: Grant) => boolean): void;
  };
  /**
   * Which App opens a file of this kind here, and by which claimed suffix (摩擦单 F39): the host knows what is
   * installed (desktop) or shipped (phone). Absent: no file says who opens it.
   */
  claimant?(typedName: string): { suffix: string; app: AppFileClaimant } | null;
  /**
   * These people's names and kinds (a file's creator, a chat's members, the page's own person), read where each host
   * reads identities: main with this token, the phone through the renderer's identity adapter (the IM architecture's one
   * reader). Someone with no row is left out.
   */
  identities(token: string, ids: readonly string[]): Promise<readonly AppIdentity[]>;
  /** A chat's members' faces by id, as `getContext().chat.members[].avatar` carries them (`lib/memberFaces.ts`). */
  faces(people: readonly { id: string; avatar: string | null }[]): Promise<Record<string, string>>;
  /** The file service over HTTP (`<supabase>/files`, or the local stack's): a document's text is read from it, as it is now. */
  filesUrl(): string;
  /**
   * How a stored file's bytes are fetched from their signed link: the desktop's main passes Chromium's (`net.fetch`), whose
   * disk cache keeps them — the file CDN answers `immutable`, and a reused link is the same URL (10-25: a 16 MB deck
   * opened again, ~0.2 s less). The phone's page already fetches through its browser.
   */
  fetchBytes?: (url: string) => Promise<Response>;
  /** The host's log, for what went wrong without failing the call (bytes a refused replacement left in the bucket). */
  warn(message: string, data?: Record<string, unknown>): void;
}

/** A person or agent as `identities` answers: `name` null when the profile has none, `avatar` (their upload) too. */
export interface AppIdentity {
  id: string;
  name: string | null;
  avatar: string | null;
  kind: 'human' | 'agent';
}

type Identities = FilesPlatform['identities'];

/** What a download saves: bytes behind a short-lived signed URL, or a document's text. */
export type DownloadSource = { name: string; kind: 'file'; url: string } | { name: string; kind: 'text'; text: string };

interface ItemRow {
  id: string;
  chat_id: string;
  kind: string;
  filename: string;
  content_type: string;
  size_bytes: number | null;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
  source_message_ids: string[] | null;
  pointer: string | null;
  version: number;
  epoch: number;
  /** 子文件夹 (gugu-supabase 20261016012659): the folder it is in, null at the top; a gugu-kept folder's role. */
  parent_id: string | null;
  system_role: string | null;
  /** Its path from the top, as every door answers it. */
  path: string;
}

/** A row `workspace_search` / `workspace_recent` answers (gugu-supabase 20261017002319): with its chat, and when opened. */
type FoundRow = ItemRow & { chat_name: string | null; chat_kind: string; opened_at?: string | null };

/** The private bucket group files live in (gugu-supabase 20260617090000_workspace_storage_bucket). */
const WORKSPACE_BUCKET = 'workspace';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A4 The messages a new chat file came from — what an entry's `sourceMessageIds` gives back, and what the folder draws
 * under the file (a tap shows the message): message ids, or none.
 */
export function sourceMessageIdsOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && UUID.test(id))) {
    throw new AppFileError('invalid', "sourceMessageIds takes message ids, as an entry's sourceMessageIds gives them");
  }
  return [...new Set(value as string[])];
}

/** A picked file's type by its name, where the picker does not say (a desktop path): the one table attachments use too. */
export function contentTypeOf(name: string): string {
  return mimeTypeFromName(name) ?? 'application/octet-stream';
}

export function tooLargeError(names: readonly string[]): AppFileError {
  return new AppFileError('too-large', `Over the ${APP_FILE_MAX_BYTES / 1024 / 1024} MB limit of a workspace file: ${names.join(', ')}`);
}

/** The version a chat file's `files.replace` names (10-13): needed, a whole number — `invalid` without it. */
export function expectedVersionOf(value: unknown): number {
  if (value === undefined || value === null) {
    throw new AppFileError('invalid', 'files.replace(file, content, { expectedVersion }) needs the version you started from: the entry\'s version, as files.list or files.open gave it', { reason: 'expected-version' });
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AppFileError('invalid', 'files.replace(file, content, { expectedVersion }) takes the version files.list or files.open gave', { reason: 'expected-version' });
  }
  return value;
}

/** A replacement that started from a version the file is no longer at: refused before a byte goes, or by the database. */
export function replacedSinceError(name: string, now: number, expected: number): AppFileError {
  return new AppFileError('content-changed', `${name} is version ${now} now, not ${expected}: someone replaced it since it was read — read it again`, { reason: 'replaced-since', name, now, expected });
}

/**
 * 摩擦单 F51: the files of a group that a tap opens with this App (their `claimedBy`), newest first — for its card's
 * 「Open」: one file opens straight away, several are listed first in the group's panel. Main's answer and the phone's.
 */
export function filesOpenedBy(
  entries: readonly AppFileEntry[],
  extensionId: string
): { itemId: string; name: string; displayName: string }[] {
  return entries
    .filter((entry) => entry.claimedBy?.id === extensionId)
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))
    .map((entry) => ({ itemId: entry.id, name: entry.name, displayName: entry.displayName }));
}

function chatClient(token: string) {
  return createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } });
}

function storageClient(token: string) {
  return createGuguSupabaseClient({ headers: { Authorization: `Bearer ${token}` } });
}

/**
 * Who reads (the person, or the agent an App's program acts as) → the resolver that signs for them, kept as the chat's is
 * (`attachmentBytes.ts`): a link it signed holds for its life, so the same version opened again is not signed again
 * (10-25: signing was 0.6–0.7 s of every open of a group file). Each call hands it the account's token as it is now.
 */
const resolvers = new Map<string, { token: string; resolver: AttachmentResolver }>();

function resolverFor(account: { token: string; userId: string }, as: string | null | undefined): AttachmentResolver {
  const key = `${account.userId}\u0000${as ?? ''}`;
  const kept = resolvers.get(key);
  if (kept) {
    kept.token = account.token;
    return kept.resolver;
  }
  const made: { token: string; resolver: AttachmentResolver } = { token: account.token, resolver: createAttachmentResolver((refs) => fetchAttachmentUrls(configuredEndpoint(made.token), refs, as)) };
  resolvers.set(key, made);
  return made.resolver;
}

/**
 * A short-lived signed URL for a stored file's bytes — one way for every file (#7290 收尾): attachments/urls signs that
 * item and version, as the one asking (`as`: an App's program acting as its agent) — the same path the chat reads; a file
 * from before the switch is signed there too (its bytes are the blob its pointer was registered as).
 */
async function signedUrlOf(account: { token: string; userId: string }, row: ItemRow, how: { version?: number; as?: string | null } = {}): Promise<string> {
  if (row.kind !== 'file') throw new AppFileError('failed', `${row.filename} has no stored bytes`);
  const link = await resolverFor(account, how.as).resolve({ kind: 'item', itemId: row.id, version: how.version ?? row.version });
  if (link.status === 'gone') throw new AppFileError('not-found', `${row.filename} has no bytes for version ${how.version ?? row.version}`);
  return link.url;
}

/** A stored file's bytes, as `files.open` hands them to the page (`AppFileOpened.bytes`). */
async function storedBytes(account: { token: string; userId: string }, row: ItemRow, how: { version?: number; as?: string | null; fetchBytes?: (url: string) => Promise<Response> } = {}): Promise<ArrayBuffer> {
  const url = await signedUrlOf(account, row, how);
  const res = await (how.fetchBytes ?? fetch)(url).catch((error: unknown) => {
    throw new AppFileError('failed', `${row.filename} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!res.ok) throw new AppFileError('failed', `${row.filename} could not be read (HTTP ${res.status})`);
  return res.arrayBuffer();
}

type Claimant = FilesPlatform['claimant'];

function entryOf(row: ItemRow, people: ReadonlyMap<string, AppFilePerson>, claimant: Claimant, deletable: ReadonlySet<string>): AppFileEntry {
  const file = { name: row.filename, contentType: row.content_type };
  const folder = row.kind === 'folder';
  // Who opens it and how its name reads come from the one answer for its kind (`typedFileName`, 摩擦单 F41 / F39). No App opens a folder.
  const claim = folder ? null : (claimant?.(typedFileName(file)) ?? null);
  return {
    id: row.id,
    chat: row.chat_id,
    name: row.filename,
    contentType: row.content_type,
    type: fileTypeOf(row.kind, row.content_type),
    parentId: row.parent_id ?? null,
    path: row.path,
    systemRole: row.system_role === 'attachments' ? 'attachments' : null,
    suffix: folder ? '' : fileSuffixOf(file),
    displayName: claim ? displayNameOf(row.filename, claim.suffix) : row.filename,
    claimedBy: claim?.app ?? null,
    size: row.size_bytes ?? null,
    version: row.version ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    createdBy: row.created_by
      ? (people.get(row.created_by) ?? { id: personId(row.created_by), name: row.created_by.slice(0, 8), kind: 'human' })
      : { id: '', name: '', kind: 'system' },
    sourceMessageIds: row.source_message_ids ?? [],
    canDelete: deletable.has(row.id),
  };
}

/**
 * Who made each file, by name and kind, in one read. A creator whose profile is gone (an erased
 * account) keeps a shortened id rather than a blank — the old panel's rule (#1709).
 */
async function peopleOf(token: string, rows: readonly ItemRow[], identities: Identities): Promise<Map<string, AppFilePerson>> {
  const ids = [...new Set(rows.map((row) => row.created_by).filter((id): id is string => !!id))];
  const people = new Map<string, AppFilePerson>();
  if (ids.length === 0) return people;
  for (const user of await identities(token, ids)) {
    people.set(user.id, { id: personId(user.id), name: user.name || user.id.slice(0, 8), kind: user.kind });
  }
  return people;
}

/** Who is in a chat (摩擦单 F36), as `getContext().chat.members` and `gugu.chats.members` carry them. */
type ChatMember = { id: string; name: string; kind: 'human' | 'agent'; avatar?: string };

/** One row of a chat's members changed, as `chat_members_changed` says it (`readMemberRosterRevision`). */
export type MemberChange = { memberId: string | null; left: boolean };

/**
 * Whether these changes moved who is in the chat — someone left, or an id not among `members` came (or one not known):
 * only then are `getContext().chat.members` read again and pushed. Every update of a member row sends one too — a read mark,
 * a pin, mute, listen mode — and those change nobody: a 112-person group sent 224 in 38 s (统筹 10-05, 画廊车道 §6).
 * Not read yet (`null`): read.
 */
export function rosterMoved(members: readonly { id: string }[] | null, changes: readonly MemberChange[]): boolean {
  if (!members) return true;
  const ids = new Set(members.map((member) => member.id));
  return changes.some((change) => change.left || !change.memberId || !ids.has(personId(change.memberId)));
}

/**
 * Faces only for the chat's own members. Read through the door an agent's `message_members` takes (`list_member_ids`), as
 * whoever reads (`asUser`: an agent; null, the person): who may see a chat's members is judged there — the reader or the
 * person in it, or in the line a topic grew out of (gugu-supabase 20261016231621) — and nobody else has any.
 */
async function membersOfChat(token: string, chatId: string, platform: Pick<FilesPlatform, 'identities' | 'faces'>, asUser: string | null): Promise<ChatMember[]> {
  const { data, error } = await chatClient(token).rpc('list_member_ids', { p_chat_id: chatId, p_as_user_id: asUser });
  if (error) throw new AppFileError('failed', error.message);
  const ids = ((data as { user_id: string }[] | null) ?? []).map((row) => row.user_id);
  if (ids.length === 0) return [];
  const byId = new Map((await platform.identities(token, ids)).map((user) => [user.id, user]));
  const faces = await platform.faces(ids.map((id) => ({ id, avatar: byId.get(id)?.avatar ?? null })));
  return ids.map((id) => {
    const user = byId.get(id);
    const face = faces[id];
    return { id: personId(id), name: user?.name || id.slice(0, 8), kind: user?.kind ?? 'human', ...(face ? { avatar: face } : {}) };
  });
}

/**
 * Each private chat's other one, by the name they gave themselves (a private chat has no name of its own): `viewerId` is
 * who looks. Read with the person's token — a private chat of one of their agents is with them, so theirs to read too.
 */
async function peerNamesOf(token: string, dms: readonly string[], viewerId: string, identities: Identities): Promise<Map<string, string>> {
  const peers = new Map<string, string>();
  if (dms.length === 0) return peers;
  const members = await fetchInChunks(dms, async (chunk) => {
    const { data, error } = await chatClient(token).from('chat_members').select('chat_id, user_id').in('chat_id', chunk);
    if (error) throw new AppFileError('failed', error.message);
    return (data as { chat_id: string; user_id: string }[] | null) ?? [];
  });
  const others = members.filter((member) => member.user_id !== viewerId);
  const names = new Map((await identities(token, others.map((member) => member.user_id))).map((user) => [user.id, user.name ?? '']));
  for (const member of others) peers.set(member.chat_id, names.get(member.user_id) ?? '');
  return peers;
}

/** A chat its reader is in, as `gugu.chats.list()` gives it: `getContext().chat`'s id, name and kind, and when it last spoke. */
export type AppChat = Pick<ExtensionChat, 'id' | 'name' | 'kind'> & { lastMessageAt: string | null };

/**
 * The chat a surface is drawn for, as `getContext().chat` carries it: its name and kind, and its group — a topic goes by
 * the group it grew out of, a private chat belongs to none (主人 10-05:「私聊也是得有面板的」). Read with the person's own
 * token. A private chat has no name of its own: it goes by the other one in it (`viewerId` is who looks), by the name
 * they gave themselves — never the viewer's remark for them, which is the viewer's own, not the App's. Null for a chat
 * with no workspace ('ai').
 */
export async function extensionChatOf(
  token: string,
  chatId: string,
  viewerId: string,
  platform: Pick<FilesPlatform, 'identities'>,
): Promise<ExtensionChat | null> {
  const read = async (id: string) => {
    const { data, error } = await chatClient(token).from('chats').select('id, kind, name, source_chat_id').eq('id', id).maybeSingle();
    if (error) throw new AppFileError('failed', error.message);
    return data as { id: string; kind: string; name: string | null; source_chat_id: string | null } | null;
  };
  let row = await read(chatId);
  if (!row) throw new AppFileError('not-found', 'This chat could not be read');
  if (row.kind === 'topic') row = row.source_chat_id ? await read(row.source_chat_id) : null;
  if (!row) throw new AppFileError('not-found', 'This chat could not be read');
  if (row.kind === 'group') return { id: row.id, name: row.name ?? '', kind: 'group', groupId: row.id };
  if (row.kind === 'dm') {
    const { data, error } = await chatClient(token).from('chat_members').select('user_id').eq('chat_id', row.id);
    if (error) throw new AppFileError('failed', error.message);
    const other = ((data as { user_id: string }[] | null) ?? []).map((member) => member.user_id).find((id) => id !== viewerId);
    const [peer] = other ? await platform.identities(token, [other]) : [];
    return { id: row.id, name: peer?.name ?? '', kind: 'dm', groupId: null };
  }
  return null;
}

/**
 * Rows as entries, as `actor` (the person, or the agent a program works for) has them: who made each, and whether `actor`
 * may delete it — the database's answer (`workspace_deletable_as`, the rule its delete keeps), one read for the batch.
 */
async function entriesOf(token: string, rows: readonly ItemRow[], platform: Pick<FilesPlatform, 'claimant' | 'identities'>, actor: string): Promise<AppFileEntry[]> {
  if (rows.length === 0) return [];
  const [people, deletable] = await Promise.all([
    peopleOf(token, rows, platform.identities),
    agentRows(token, 'workspace_deletable_as', { p_item_ids: rows.map((row) => row.id), p_as_user_id: actor }),
  ]);
  // A set of ids, as PostgREST answers a SETOF uuid.
  const mayDelete = new Set(deletable as unknown as string[]);
  return rows.map((row) => entryOf(row, people, platform.claimant, mayDelete));
}

/** Every row of a chat, newest first, as `actor` (the person, or the agent a program works for) sees them. */
function rowsOfChat(token: string, chatId: string, actor: string): Promise<ItemRow[]> {
  return agentRows(token, 'workspace_list_as', { p_chat_id: chatId, p_as_user_id: actor });
}

/** The folder's codes (子文件夹, gugu-supabase 20261016012659): its refusals carry one in `hint`, its message is for people. */
const FOLDER_CODES: Readonly<Record<string, AppFileError['code']>> = {
  workspace_name_taken: 'name-taken',
  workspace_system_folder: 'denied',
  workspace_folder_not_yours: 'denied',
  workspace_item_not_yours: 'denied',
  workspace_folder_not_found: 'not-found',
  workspace_not_a_folder: 'invalid',
  workspace_bad_parent: 'invalid',
  workspace_too_deep: 'invalid',
  workspace_bad_kind: 'invalid',
  workspace_folder_not_empty: 'invalid',
  workspace_mkdir: 'invalid',
  workspace_move: 'invalid',
  workspace_not_member: 'denied',
  workspace_item_not_found: 'not-found',
  workspace_no_version: 'not-found',
  workspace_version_conflict: 'content-changed',
};

/**
 * What a door's refusal was, in the codes an App branches on: every door says its code in `hint` (its message is a
 * sentence for people, which already-shipped clients read as it is).
 */
function codeOf(error: { message: string; hint?: string | null }): AppFileError['code'] {
  return (error.hint ? FOLDER_CODES[error.hint] : undefined) ?? 'failed';
}

/**
 * What attachments/* said a refusal was, in the codes an App branches on. A folder's own refusal comes through as the
 * database's hint (gugu-supabase: the function passes `workspace_*` on), read as every door's is (`FOLDER_CODES`); the
 * function's own codes after that. An upload it no longer has is this side's failure, not a file that is not there.
 */
const ATTACHMENTS_CODES: Readonly<Record<string, AppFileError['code']>> = {
  denied: 'denied',
  invalid: 'invalid',
  too_large: 'too-large',
};

/** The code a refusal keeps on its way out: the door's own, or what attachments/* said; anything else failed. */
function refusalCode(error: unknown): AppFileError['code'] {
  if (error instanceof AppFileError) return error.code;
  if (error instanceof AttachmentsError) return FOLDER_CODES[error.code] ?? ATTACHMENTS_CODES[error.code] ?? 'failed';
  return 'failed';
}

/** A folder is listed and entered, never opened or saved: said, with where to look instead. */
function notAFile(row: ItemRow): AppFileError {
  return new AppFileError('invalid', `${row.filename} is a folder: what is in it is listed with files.list({ chat, folder })`, { reason: 'folder' });
}

/** A file of a chat, as a call names it: by its item id (its chat checked when given), or by its name in a chat. */
export type ChatFileRef = Exclude<AppFileRef, LocalPlace>;

/** One row by its id, as `actor` sees it: not there and not theirs read the same (null). */
async function itemById(token: string, itemId: string, actor: string): Promise<ItemRow | null> {
  if (!UUID.test(itemId)) return null;
  const { data, error } = await chatClient(token).rpc('workspace_get_as', { p_item_id: itemId, p_as_user_id: actor });
  if (error) {
    if (codeOf(error) === 'not-found') return null;
    throw new AppFileError(codeOf(error), error.message);
  }
  return ((Array.isArray(data) ? data[0] : data) as ItemRow | undefined) ?? null;
}

/**
 * A file by its path from the top of the chat's folder (子文件夹; a name alone is at the top), found by the database — the
 * person's as an agent's: `workspace_list_as` reads the folders on the way (`workspace_folder_for`: names as it keeps them,
 * 「附件」 at the top by its role) and matches the last part to the names it stored, by its own rule (`p_exact`: an NFD name
 * from macOS, an emoji, an invisible character), so a path means one thing whoever asks. `actor` = the agent, or the person
 * themselves. The rows it lists carry no epoch, so each is read again by its id.
 */
async function itemsByPath(token: string, chatId: string, path: string, actor: string): Promise<ItemRow[]> {
  const parts = path.split('/').map((part) => part.trim()).filter(Boolean);
  const named = parts.pop();
  if (named === undefined) return [];
  const found = await agentRows(token, 'workspace_list_as', { p_chat_id: chatId, p_as_user_id: actor, p_name: named, p_folder: parts.join('/'), p_exact: true }).catch(
    (error: unknown) => {
      if (error instanceof AppFileError && error.code === 'not-found') return [];
      throw error;
    },
  );
  return (await Promise.all(found.map((row) => itemById(token, row.id, actor)))).filter((row): row is ItemRow => row !== null);
}

/**
 * An upload the database renamed (子文件夹: a name its folder already had, case not counted, gets 「 (n)」): the file of
 * that folder whose name it was picked with — the database's to say (`workspace_clash_as`: the name picked, stored by its
 * own rule, as the folder keeps names apart); null when it kept its name. `actor` = the agent, or the person themselves.
 */
async function clashOf(token: string, row: ItemRow, picked: string, actor: string, warn: FilesPlatform['warn']): Promise<string | null> {
  // The files are in by now: a clash the database could not say (the row deleted before it was asked, the network) is no
  // clash — said in the host's log, and the upload stands.
  try {
    const { data, error } = await chatClient(token).rpc('workspace_clash_as', { p_item_id: row.id, p_as_user_id: actor, p_picked: picked });
    if (error) throw new Error(error.message);
    return typeof data === 'string' ? data : null;
  } catch (error) {
    warn('an upload could not be told which file it clashed with: nothing is asked', { item: row.id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** A topic names its source's resources. Read as the actor, even when its owner is not in that chat. */
export async function resourceChatIdOf(token: string, chatId: string, actor: string): Promise<string> {
  const { data, error } = await chatClient(token).rpc('chat_facts', { p_chat_id: chatId, p_as_user_id: actor });
  if (error) throw new AppFileError('failed', error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { id: string; kind: string; source_chat_id: string | null } | null;
  if (!row) throw new AppFileError('not-found', 'This chat could not be read');
  if (row.kind !== 'topic') return row.id;
  if (row.source_chat_id) return row.source_chat_id;
  throw new AppFileError('invalid', 'This topic has no source chat');
}

/** Resolve `ref` in the resource container it names. Not-there and not-yours read the same. */
async function resolve(surface: FileSurface, account: { token: string; userId: string }, ref: ChatFileRef): Promise<{ row: ItemRow; handedOver: boolean }> {
  const { token } = account;
  const actor = surface.asAgent ?? account.userId;
  if ('id' in ref) {
    const row = await itemById(token, ref.id, actor);
    if (!row) throw new AppFileError('not-found', 'No such file in a chat you are in');
    // Both said, and they disagree: the call is wrong, said where — the person can read the file, so naming its chat tells nothing new.
    if (ref.chat !== undefined && row.chat_id !== ref.chat && row.chat_id !== await resourceChatIdOf(token, ref.chat, actor)) {
      throw new AppFileError('invalid', `File ${ref.id} is in chat ${row.chat_id}, not ${ref.chat}: pass the entry or ctx.file as it is`);
    }
    return { row, handedOver: row.id === surface.itemId };
  }
  const rows = await itemsByPath(token, ref.chat, ref.name, actor);
  if (rows.length === 0) throw new AppFileError('not-found', `No file named ${JSON.stringify(ref.name)} in that chat`);
  if (rows.length > 1) {
    throw new AppFileError('ambiguous', `${rows.length} files are named ${JSON.stringify(ref.name)}; pass an entry from gugu.files.list({ chat }) instead`);
  }
  return { row: rows[0]!, handedOver: rows[0]!.id === surface.itemId };
}

/** A live text file: what `files.create` makes, and what an upload of a text file becomes (F19). A name another file of
 * that folder has gets 「 (n)」 from the database (子文件夹). */
function insertDocument(
  token: string,
  doc: { chatId: string; name: string; contentType: string; content: string; sourceMessageIds: readonly string[]; parentId: string | null },
  actor: string,
): Promise<ItemRow> {
  return agentRow(token, 'workspace_create_document_as', { p_chat_id: doc.chatId, p_as_user_id: actor, p_title: doc.name,
    p_content: doc.content, p_content_type: doc.contentType, p_source_message_ids: doc.sourceMessageIds, p_folder: doc.parentId });
}

/**
 * The folder a new file goes in, by its id (子文件夹): made all the way down when it is not there, through the door — as the
 * person, or the agent a program works for. Not given, '' or '/': the top.
 */
async function folderIdFor(token: string, chatId: string, folder: string | undefined, actor: string): Promise<string | null> {
  if (!folder || folder === '/') return null;
  return (await agentRow(token, 'workspace_mkdir_as', { p_chat_id: chatId, p_as_user_id: actor, p_path: folder })).id;
}

/**
 * The folder's one door (`workspace_*_as`, #6492), as the person or the agent a program acts for: whoever acts, their own
 * membership decides, and what they make is their own — the door the agent's own tools take too.
 */
async function agentRows(token: string, name: string, args: Record<string, unknown>): Promise<ItemRow[]> {
  const { data, error } = await chatClient(token).rpc(name, args);
  // Its doors say not-a-member and not-found in one sentence each, on purpose (a chat it is not in is not there); the
  // folder's (子文件夹, gugu-supabase 20261016012659) say their code in hint — deleting what someone else made among them.
  if (error) throw new AppFileError(codeOf(error), error.message);
  return (Array.isArray(data) ? data : data ? [data] : []) as ItemRow[];
}

async function agentRow(token: string, name: string, args: Record<string, unknown>): Promise<ItemRow> {
  const [row] = await agentRows(token, name, args);
  if (!row) throw new AppFileError('failed', `${name} answered with no file`);
  return row;
}

/** The bytes a stored file's history keeps (G1), as `actor` reads it. */
async function versionPointers(token: string, row: ItemRow, actor: string): Promise<string[]> {
  const kept = await agentRows(token, 'workspace_versions_as', { p_item_id: row.id, p_as_user_id: actor });
  return kept.flatMap((version) => (version.pointer ? [version.pointer] : []));
}


export function createAppFiles(platform: FilesPlatform) {
  /** Found rows as entries, each with its chat's name — a private chat goes by the other one in it, as its panel says. */
  async function found(token: string, rows: readonly FoundRow[], viewerId: string): Promise<AppFileEntry[]> {
    const entries = await entriesOf(token, rows, platform, viewerId);
    const dms = [...new Set(rows.filter((row) => row.chat_kind === 'dm').map((row) => row.chat_id))];
    const peers = await peerNamesOf(token, dms, viewerId, platform.identities);
    return entries.map((entry, i) => {
      const row = rows[i]!;
      return { ...entry, chatName: row.chat_kind === 'dm' ? (peers.get(row.chat_id) ?? '') : (row.chat_name ?? ''), ...(row.opened_at ? { openedAt: row.opened_at } : {}) };
    });
  }

  const has = (extensionId: string, capability: 'files:read' | 'files:write') => platform.hasCapability(extensionId, capability);
  const selfNames = new Map<string, string>();
  /** Bytes behind a row that is gone (or never made it): one left in the bucket is said, not swallowed. */
  const removeBytes = async (token: string, pointers: string[], left: string): Promise<void> => {
    const removed = await storageClient(token).storage.from(WORKSPACE_BUCKET).remove(pointers)
      .catch((thrown: unknown) => ({ error: thrown instanceof Error ? thrown : new Error(String(thrown)) }));
    if (removed.error) platform.warn(left, { pointers, error: removed.error.message });
  };
  const entryOne = async (token: string, row: ItemRow, actor: string): Promise<AppFileEntry> => (await entriesOf(token, [row], platform, actor))[0]!;

  async function selfName(token: string, userId: string): Promise<string> {
    const known = selfNames.get(userId);
    if (known !== undefined) return known;
    // No row opens the file unnamed; a read that failed is said, and never kept as this person's name.
    const name = (await platform.identities(token, [userId]))[0]?.name ?? '';
    selfNames.set(userId, name);
    return name;
  }

  /** Who this person is, as an open file stamps them (`AppFileOpened.self`): a working copy's files say the same. */
  async function self(): Promise<AppFileOpened['self']> {
    const { token, userId } = await platform.account();
    return { userId: personId(userId), name: await selfName(token, userId) };
  }

  async function open(surface: FileSurface, args: { ref: ChatFileRef; readOnly?: boolean }): Promise<AppFileOpened> {
    const { token, userId } = await platform.account();
    const { row, handedOver } = await resolve(surface, { token, userId }, args.ref);
    if (row.kind === 'folder') throw notAFile(row);
    // A stored file (an image, a clip, a sound) opens read-only, as its bytes: there is no document to edit or sync.
    const stored = row.kind !== 'document';
    let access: Grant['access'];
    let needs: Grant['needs'];
    if (handedOver) {
      access = args.readOnly || stored ? 'ro' : 'rw';
      needs = null;
    } else if (!args.readOnly && !stored && has(surface.extensionId, 'files:write')) {
      access = 'rw';
      needs = 'files:write';
    } else if (has(surface.extensionId, 'files:read') || has(surface.extensionId, 'files:write')) {
      access = 'ro';
      needs = has(surface.extensionId, 'files:read') ? 'files:read' : 'files:write';
    } else {
      throw new AppFileError('denied', 'Not permitted: opening a file other than the one this page was opened for needs "files:read" or "files:write"');
    }
    const actor = surface.asAgent ?? userId;
    const self = { userId: personId(actor), name: await selfName(token, actor) };
    if (stored) return { entry: await entryOne(token, row, actor), docName: '', access, self, bytes: await storedBytes({ token, userId }, row, { as: surface.asAgent, fetchBytes: platform.fetchBytes }) };
    if (typeof row.epoch !== 'number') throw new AppFileError('failed', `${row.filename}: the server did not say which version of the file is open`);
    const docName = `${row.id}@${row.epoch}`;
    const page = platform.sync.pageFor(surface.pageId, surface.extensionId);
    platform.sync.grant(page, { docName, itemId: row.id, access, needs, ...(surface.asAgent ? { asAgent: surface.asAgent } : {}) });
    return { entry: await entryOne(token, row, actor), docName, access, self };
  }

  /** A file the page may read: the one handed to it, or any other with `files:read`/`:write`. */
  async function readable(surface: FileSurface, account: { token: string; userId: string }, ref: ChatFileRef, what: 'saving' | 'opening'): Promise<ItemRow> {
    const { row, handedOver } = await resolve(surface, account, ref);
    if (row.kind === 'folder') throw notAFile(row);
    if (!handedOver && !has(surface.extensionId, 'files:read') && !has(surface.extensionId, 'files:write')) {
      throw new AppFileError('denied', `Not permitted: ${what} a file other than the one this page was opened for needs "files:read" or "files:write"`);
    }
    return row;
  }

  /**
   * `folder` (子文件夹): only what is directly in it — its path or id, '' the top — found the way the database finds it
   * (`workspace_list_as`, the person's as an agent's); not given, every file and folder of the chat.
   */
  async function groupFiles(chatId: string, as: { asAgent?: string | null; folder?: string } = {}): Promise<AppFileEntry[]> {
    const { token, userId } = await platform.account();
    const actor = as.asAgent ?? userId;
    if (as.folder !== undefined) {
      return entriesOf(token, await agentRows(token, 'workspace_list_as', { p_chat_id: chatId, p_as_user_id: actor, p_folder: as.folder.replace(/^\/+|\/+$/g, '') }), platform, actor);
    }
    // Acting for an agent (A2): what the agent sees, by its own membership — never the person's chats (#6492).
    return entriesOf(token, await rowsOfChat(token, chatId, actor), platform, actor);
  }

  /**
   * Some of a chat's files by id, as `groupFiles` gives them — what a page hears in `files.onChanged({ chat })` when the
   * account's revisions named them (#7257): the ones still there, and the ids that are not (gone, or no longer seen by
   * whoever reads). One read per file through the door.
   */
  async function groupEntries(chatId: string, ids: readonly string[], as: { asAgent?: string | null } = {}): Promise<{ entries: AppFileEntry[]; gone: string[] }> {
    const wanted = [...new Set(ids)].filter((id) => UUID.test(id));
    if (wanted.length === 0) return { entries: [], gone: [] };
    const { token, userId } = await platform.account();
    const rows = (await Promise.all(wanted.map((id) => itemById(token, id, as.asAgent ?? userId)))).filter((row): row is ItemRow => row !== null);
    if (rows.some((row) => row.chat_id !== chatId)) chatId = await resourceChatIdOf(token, chatId, as.asAgent ?? userId);
    const here = rows.filter((row) => row.chat_id === chatId);
    const found = new Set(here.map((row) => row.id));
    return { entries: await entriesOf(token, here, platform, as.asAgent ?? userId), gone: wanted.filter((id) => !found.has(id)) };
  }

  /**
   * What a page hears of a chat's files a batch of revisions named (#7257): those files (`groupEntries`), or — `all`, past
   * so many ids or when every one changed (who opens which) — every file of the chat, the named ids not among them gone.
   */
  async function groupChange(chatId: string, wanted: { ids: readonly string[]; all: boolean }, as: { asAgent?: string | null } = {}): Promise<{ entries: AppFileEntry[]; gone: string[] }> {
    if (!wanted.all) return groupEntries(chatId, wanted.ids, as);
    const entries = await groupFiles(chatId, as);
    const there = new Set(entries.map((entry) => entry.id));
    return { entries, gone: [...new Set(wanted.ids)].filter((id) => !there.has(id)) };
  }

  /**
   * 子文件夹: a file or folder into another folder (`folder`: its path or id, '' the top — made all the way down when it
   * is not there; not given, where it is), renamed too when `name` is given. One door for the person and an agent
   * (`workspace_move_as`): a name that folder already has is `name-taken`, the 「附件」 folder `denied`.
   */
  async function move(surface: FileSurface, args: { ref: ChatFileRef; folder?: unknown; name?: unknown }): Promise<AppFileEntry> {
    const { token, userId } = await platform.account();
    const folder = folderOf(args.folder);
    const name = args.name === undefined || args.name === null ? null : String(args.name).trim();
    if (name === '') throw new AppFileError('invalid', 'A file needs a name');
    if (folder === undefined && name === null) {
      throw new AppFileError('invalid', 'files.move(file, { folder, name }) puts it in another folder, renames it, or both: say which');
    }
    const { row } = await resolve(surface, { token, userId }, args.ref);
    const moved = await agentRow(token, 'workspace_move_as', { p_item_id: row.id, p_as_user_id: surface.asAgent ?? userId, p_folder: folder ?? null, p_name: name });
    return entryOne(token, moved, surface.asAgent ?? userId);
  }

  return {
    open,
    self,

    async resourceChat(chatId: string, as: { asAgent?: string | null } = {}): Promise<string> {
      const { token, userId } = await platform.account();
      return resourceChatIdOf(token, chatId, as.asAgent ?? userId);
    },

    /** After `stale-epoch:<n>`: the same file at its new epoch; the old open file is dropped. */
    async reopen(surface: FileSurface, args: { ref: Extract<ChatFileRef, { id: string }>; readOnly?: boolean }): Promise<AppFileOpened> {
      const opened = await open(surface, { ref: args.ref, ...(args.readOnly ? { readOnly: true } : {}) });
      const itemId = opened.entry.id;
      platform.sync.revoke(surface.pageId, null, (grant) => grant.itemId === itemId && grant.docName !== opened.docName);
      return opened;
    },

    close(surface: FileSurface, args: { docName: string }): void {
      platform.sync.ungrant(surface.pageId, String(args.docName));
    },

    /** The chat a file is in, as this person sees it: a file handed to a program by its id says (F16). */
    async chatOf(itemId: string): Promise<string> {
      const { token, userId } = await platform.account();
      const row = await itemById(token, String(itemId), userId);
      if (!row) throw new AppFileError('not-found', 'No such file in a chat you are in');
      return row.chat_id;
    },

    /**
     * A chat's files, as this person sees them — a page's `files.list({ chat })` (gated at the door), and the shell acting
     * for them: an App card's 「Open」 (摩擦单 F51), a file link in the chat (F10). Read with their token, so a chat they
     * are not in has none. A program acting for an agent there (A1, G5) lists what the agent sees.
     */
    groupFiles,

    /**
     * Files across every chat whoever reads is in — the person, or the agent its page works as (its own membership) — found
     * by a piece of their path, newest first; and the ones this person opened last (`noteOpened`), in the chats whoever reads
     * is still in. One read each, joined from the reader's chats in the database.
     */
    async search(args: AppFileSearch, as: { asAgent?: string | null } = {}): Promise<AppFileEntry[]> {
      const { token, userId } = await platform.account();
      const rows = await agentRows(token, 'workspace_search', {
        p_query: args.query ?? null,
        p_suffixes: args.suffixes ?? null,
        p_limit: args.limit ?? 50,
        p_as_user_id: as.asAgent ?? null,
      });
      return found(token, rows as FoundRow[], as.asAgent ?? userId);
    },

    async recent(args: { limit?: number }, as: { asAgent?: string | null } = {}): Promise<AppFileEntry[]> {
      const { token, userId } = await platform.account();
      const rows = await agentRows(token, 'workspace_recent', { p_limit: args.limit ?? 50, p_as_user_id: as.asAgent ?? null });
      return found(token, rows as FoundRow[], as.asAgent ?? userId);
    },

    groupEntries,

    groupChange,

    /** One of them, as `openTarget` answers for a page: what to open, and what kind of file it is. */
    async groupFile(chatId: string, itemId: string) {
      const { token, userId } = await platform.account();
      const row = await itemById(token, String(itemId), userId);
      if (row && row.chat_id !== chatId) chatId = await resourceChatIdOf(token, chatId, userId);
      if (!row || row.chat_id !== chatId) throw new AppFileError('not-found', 'No such file in this chat');
      return { chatId: row.chat_id, itemId: row.id, name: row.filename, typedName: typedFileName({ name: row.filename, contentType: row.content_type }), file: { document: row.kind === 'document', contentType: row.content_type, version: row.version, size: row.size_bytes ?? 0 } };
    },

    /**
     * API 14 `chatFile`: the file an App names for a chat, as a file of it opened with that App — at the top of the chat's
     * folder, made empty for the person the first time (`{}` for JSON, a JSON file holding an object; the App fills it).
     * Two making it at once: the folder names the later one apart, which goes again, and both open the first.
     */
    async appChatFile(chatId: string, manifest: ExtensionManifest | undefined): Promise<AppOpenWithDetail> {
      const tab = manifest?.contributes.tabs.find((candidate) => candidate.chatFile !== undefined);
      const name = tab?.chatFile;
      if (!manifest || !tab || !name) throw new AppFileError('not-found', `${manifest?.id ?? 'That App'} names no file of a chat (chatFile)`);
      const candidate = fileOpenersFor(name, [manifest], 'chat').find((opener) => opener.tabKind === `${manifest.id}.${tab.name}`);
      if (!candidate) throw new AppFileError('invalid', `${manifest.id}.${tab.name} does not open ${name} in a chat`);
      const { token, userId } = await platform.account();
      const first = async () => (await itemsByPath(token, chatId, name, userId)).find((row) => row.kind !== 'folder' && row.parent_id === null);
      let row = await first();
      if (!row) {
        const contentType = contentTypeOf(name);
        const made = await insertDocument(token, { chatId, name, contentType, content: /json/i.test(contentType) ? '{}' : '', sourceMessageIds: [], parentId: null }, userId);
        if (made.filename !== name) await agentRows(token, 'workspace_delete_as', { p_item_id: made.id, p_as_user_id: userId });
        row = made.filename === name ? made : await first();
        if (!row) throw new AppFileError('failed', `${name} was made as ${made.filename}, and the one it gave way to is gone`);
      }
      return { ...(await this.groupFile(chatId, row.id)), choice: { kind: 'one', candidate } };
    },

    /** `folder` (子文件夹): the folder it goes in, made all the way down when it is not there; not given, the top. */
    async create(chatId: string, args: { name: string; content: string; contentType?: string; sourceMessageIds?: unknown; folder?: unknown },
      as: { asAgent?: string | null } = {}): Promise<AppFileEntry> {
      const { token, userId } = await platform.account();
      const name = String(args.name ?? '').trim();
      if (!name) throw new AppFileError('invalid', 'A file needs a name');
      const sourceMessageIds = sourceMessageIdsOf(args.sourceMessageIds);
      const folder = folderOf(args.folder);
      const content = String(args.content ?? '');
      const contentType = typeof args.contentType === 'string' && args.contentType ? args.contentType : 'text/markdown';
      if (/json/i.test(contentType)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          throw new AppFileError('invalid', 'That is not valid JSON');
        }
        // The open file's root is a map: a JSON file whose top is not an object could never open.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new AppFileError('invalid', 'A JSON file must hold an object at the top');
        }
      }
      const actor = as.asAgent ?? userId;
      const parentId = await folderIdFor(token, chatId, folder, actor);
      return entryOne(token, await insertDocument(token, { chatId, name, contentType, content, sourceMessageIds, parentId }, actor), actor);
    },

    /** 子文件夹: a chat's folder at `path`, made all the way down — one already there is answered as it is. */
    async mkdir(chatId: string, args: { path?: unknown }, as: { asAgent?: string | null } = {}): Promise<AppFileEntry> {
      const { token, userId } = await platform.account();
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (!path || path === '/') throw new AppFileError('invalid', "files.mkdir({ chat, path }) needs the folder's path, such as '合同/2026'");
      const actor = as.asAgent ?? userId;
      return entryOne(token, await agentRow(token, 'workspace_mkdir_as', { p_chat_id: chatId, p_as_user_id: actor, p_path: path }), actor);
    },

    move,

    /** Rename in place: only its name changes (真源 §2.5) — a move that stays in its folder. The folder App's edit(item_id, name) for an agent. */
    async rename(surface: FileSurface, args: { ref: ChatFileRef; name: string }): Promise<AppFileEntry> {
      const name = String(args.name ?? '').trim();
      if (!name) throw new AppFileError('invalid', 'A file needs a name');
      return move(surface, { ref: args.ref, name });
    },

    /**
     * A file, or a folder with everything in it (子文件夹), through the door: every one of them deletable by whoever asks,
     * or none goes. The kept versions' bytes are read first (the history rows go with the rows); after, only the bytes of
     * the rows the door says it deleted go — a file moved out of the folder meanwhile kept its row, and keeps its bytes
     * (one moved in meanwhile goes with its current bytes; its older versions' are left, unreferenced, not lost).
     */
    async remove(surface: FileSurface, args: { ref: ChatFileRef }): Promise<void> {
      const { token, userId } = await platform.account();
      const actor = surface.asAgent ?? userId;
      const { row } = await resolve(surface, { token, userId }, args.ref);
      let stored: ItemRow[] = row.kind === 'file' ? [row] : [];
      if (row.kind === 'folder') {
        const all = await rowsOfChat(token, row.chat_id, actor);
        const inside = new Set([row.id]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const other of all) {
            if (other.parent_id && inside.has(other.parent_id) && !inside.has(other.id)) {
              inside.add(other.id);
              grew = true;
            }
          }
        }
        stored = all.filter((other) => inside.has(other.id) && other.kind === 'file');
      }
      const kept = new Map(await Promise.all(stored.map(async (other) => [other.id, await versionPointers(token, other, actor)] as const)));
      const gone = await agentRows(token, 'workspace_delete_as', { p_item_id: row.id, p_as_user_id: actor });
      // The rows went first, then the bytes behind them: never a row pointing at nothing.
      const bytes = [...new Set(gone.flatMap((other) => [...(other.kind === 'file' && other.pointer ? [other.pointer] : []), ...(kept.get(other.id) ?? [])]))];
      if (bytes.length > 0) await removeBytes(token, bytes, row.kind === 'folder' ? 'a deleted folder left bytes in the bucket' : 'a deleted file left bytes in the bucket');
    },

    /**
     * G2 A file's kept versions, newest first — read like opening it read-only, through `workspace_versions_as` (the
     * person, or the agent an App's program acts for: one path). Restoring one is writing it back as a change of now.
     */
    async versions(surface: FileSurface, args: { ref: ChatFileRef }): Promise<AppFileVersion[]> {
      const { token, userId } = await platform.account();
      const row = await readable(surface, { token, userId }, args.ref, 'opening');
      const { data, error } = await chatClient(token).rpc('workspace_versions_as', { p_item_id: row.id, p_as_user_id: surface.asAgent ?? userId });
      if (error) throw new AppFileError('failed', `${row.filename}: its versions could not be read: ${error.message}`);
      const kept = (data as { n: number; made_by: string | null; made_at: string; size_bytes: number | null }[] | null) ?? [];
      const ids = [...new Set(kept.flatMap((version) => (version.made_by ? [version.made_by] : [])))];
      const people = new Map((ids.length ? await platform.identities(token, ids) : []).map((who) => [who.id, who]));
      return kept.map((version) => {
        const who = version.made_by ? people.get(version.made_by) : undefined;
        return {
          n: version.n,
          by: version.made_by ? { id: personId(version.made_by), name: who?.name ?? version.made_by.slice(0, 8), kind: who?.kind ?? 'human' } : null,
          at: version.made_at,
          size: version.size_bytes ?? null,
        };
      });
    },

    /** G2 One kept version's content: a text file's text, a stored file's bytes. Gated as `versions`. */
    async readVersion(surface: FileSurface, args: { ref: ChatFileRef; n: number }): Promise<AppFileVersionContent> {
      const { token, userId } = await platform.account();
      if (!Number.isInteger(args.n)) throw new AppFileError('invalid', 'files.readVersion(file, n) takes a version\'s n, as files.versions gives it');
      const row = await readable(surface, { token, userId }, args.ref, 'opening');
      const { data, error } = await chatClient(token).rpc('workspace_version_as', { p_item_id: row.id, p_as_user_id: surface.asAgent ?? userId, p_n: args.n });
      if (error) throw new AppFileError(codeOf(error), `${row.filename}: ${error.message}`);
      const version = ((Array.isArray(data) ? data[0] : data) ?? null) as { n: number; pointer: string | null; inline_text: string | null; content_type: string } | null;
      if (!version) throw new AppFileError('not-found', `${row.filename} has no version ${args.n}`);
      if (version.inline_text !== null) return { n: version.n, text: version.inline_text };
      const bytes = await storedBytes({ token, userId }, { ...row, pointer: version.pointer }, { version: version.n, as: surface.asAgent, fetchBytes: platform.fetchBytes });
      return { n: version.n, bytes, contentType: version.content_type };
    },

    /**
     * G1 A stored file's content replaced: the same file, its next version. The bytes go to OSS, then the server
     * (attachments/place, `file_replace_as`) — one path for a person and an App's program acting as an agent (the folder App's
     * edit(item_id, path)) — keeps what it had as history; old bucket bytes of versions beyond the newest 50 are removed here.
     * A live text file changes through its open file, never by replacing it.
     * `expectedVersion` (the entry's `version` when it was read), needed: replaced only if it is still that version, else
     * `content-changed` — two writers each starting from what they read, the later one is told instead of winning. A
     * replacement that names no version is refused (`invalid`): one that does not know what it replaces is the one that
     * wipes another's change (10-13). Every way in — a page, an App's program, the phone, and the folder App's
     * edit(item_id, path, expected_version) for an agent — comes through here, so this is the one check.
     */
    async replace(surface: FileSurface, args: { ref: ChatFileRef; file: AppFileUpload; expectedVersion?: number | null }): Promise<AppFileEntry> {
      const { token, userId } = await platform.account();
      const file = args.file;
      if (!file || !(file.bytes instanceof ArrayBuffer)) throw new AppFileError('invalid', 'files.replace(file, content) takes the new content: a Blob');
      const expected = expectedVersionOf(args.expectedVersion);
      const { row, handedOver } = await resolve(surface, { token, userId }, args.ref);
      if (!handedOver && !has(surface.extensionId, 'files:write')) {
        throw new AppFileError('denied', 'Not permitted: replacing a file other than the one this page was opened for needs "files:write"');
      }
      if (row.kind === 'folder') throw notAFile(row);
      if (row.kind !== 'file') {
        throw new AppFileError('invalid', `${row.filename} is a live text file: change it through files.open, it is never replaced`, { reason: 'live-text-file' });
      }
      if (file.bytes.byteLength > APP_FILE_MAX_BYTES) throw tooLargeError([row.filename]);
      // Gone by already: refused before a byte goes. The database checks again.
      if (row.version !== expected) throw replacedSinceError(row.filename, row.version, expected);
      const contentType = file.contentType || row.content_type;
      // #7290 gugu-3: the bytes go to OSS (attachments/upload) and the server makes them the next version (attachments/place);
      // an upload the server refused is nobody's and goes on its own (unclaimed uploads expire).
      const endpoint = configuredEndpoint(token);
      let replaced: ItemRow & { version: number; pruned_pointers: string[] | null };
      try {
        const stagingKey = await uploadAttachmentBytes(endpoint, { bytes: new Uint8Array(file.bytes), name: row.filename, contentType });
        replaced = await placeAttachment(endpoint, {
          staging_key: stagingKey, item_id: row.id, expected_version: expected, as_user_id: surface.asAgent ?? userId, content_type: contentType,
        }) as unknown as ItemRow & { version: number; pruned_pointers: string[] | null };
      } catch (error) {
        const changed = error instanceof AttachmentsError && error.code === 'version_conflict' ? /got (\d+)/.exec(error.message) : null;
        if (changed) throw replacedSinceError(row.filename, Number(changed[1]), expected);
        throw new AppFileError(refusalCode(error), `${row.filename} was not replaced: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Versions older than the 50 kept, from before the switch, still have their bytes in the workspace bucket.
      const pruned = replaced.pruned_pointers ?? [];
      if (pruned.length > 0) {
        const removed = await storageClient(token).storage.from(WORKSPACE_BUCKET).remove(pruned);
        if (removed.error) {
          throw new AppFileError('failed', `${row.filename} is replaced (version ${replaced.version}), but ${pruned.length} copies older than its 50 versions could not be removed: ${removed.error.message}`);
        }
      }
      return entryOne(token, replaced, surface.asAgent ?? userId);
    },

    /**
     * Upload each file into a chat's workspace. A text file (F19, `workspaceUploadKind` — the one rule) becomes a live document, as `create` makes; anything else is a file item:
     * the bytes to OSS, then the server puts the file in the folder (attachments/place) — an upload it refused is nobody's and expires.
     * Every size is checked before the first byte goes. Not a transaction across files: if one
     * fails, the ones before it stay, and the rejection names what did not get in.
     */
    async upload(chatId: string, files: readonly AppFileUpload[], as: { asAgent?: string | null; sourceMessageIds?: unknown; folder?: unknown } = {}): Promise<AppFileEntry[]> {
      const { token, userId } = await platform.account();
      const sourceMessageIds = sourceMessageIdsOf(as.sourceMessageIds);
      const folder = folderOf(as.folder);
      for (const file of files) {
        if (!file || typeof file.name !== 'string' || !file.name.trim() || !(file.bytes instanceof ArrayBuffer)) {
          throw new AppFileError('invalid', 'Each upload needs a name and its bytes');
        }
      }
      const tooLarge = files.filter((file) => file.bytes.byteLength > APP_FILE_MAX_BYTES).map((file) => file.name);
      if (tooLarge.length > 0) throw tooLargeError(tooLarge);
      // G5 Written as whoever acts — the person, or the agent an App's program works for, by its own membership (#6492).
      // Checked before a byte goes, so a chat they are not in keeps nothing.
      const actor = as.asAgent ?? userId;
      const { error } = await chatClient(token).rpc('workspace_status_as', { p_chat_id: chatId, p_as_user_id: actor });
      if (error) throw new AppFileError(codeOf(error), `Not uploaded: ${error.message}`);
      // 子文件夹: the folder they go in, made all the way down when it is not there; not given, the top.
      const parentId = await folderIdFor(token, chatId, folder, actor);
      const rows: ItemRow[] = [];
      for (const [index, file] of files.entries()) {
        const name = file.name.trim();
        const contentType = file.contentType || contentTypeOf(name);
        try {
          const asText = workspaceUploadKind(name, contentType, new Uint8Array(file.bytes));
          if (asText.kind === 'document') {
            rows.push(await insertDocument(token, { chatId, name, contentType: asText.contentType, content: asText.text, sourceMessageIds, parentId }, actor));
            continue;
          }
          // #7290 gugu-3: a stored file's bytes go to OSS (attachments/upload); the server puts it in the folder (attachments/place),
          // as the agent or the person — the folder made all the way down when it is not there, as folderIdFor does.
          const endpoint = configuredEndpoint(token);
          const stagingKey = await uploadAttachmentBytes(endpoint, { bytes: new Uint8Array(file.bytes), name, contentType });
          rows.push(await placeAttachment(endpoint, {
            staging_key: stagingKey, chat_id: chatId, file_name: name, folder: folder ?? null, as_user_id: actor,
            source_message_ids: sourceMessageIds, content_type: contentType,
          }) as unknown as ItemRow);
        } catch (error) {
          const notIn = files
            .slice(index)
            .map((f) => f.name)
            .join(', ');
          const why = error instanceof Error ? error.message : String(error);
          // The door's own refusal keeps its code (and detail) — the App branches on it; anything else failed.
          throw new AppFileError(refusalCode(error), `Upload stopped at ${name} (${why}); not uploaded: ${notIn}`, error instanceof AppFileError ? error.detail : undefined);
        }
      }
      // A row per file, in order: each says which file of its folder already had the name it was picked with — the
      // database gave this one 「 (n)」 (子文件夹), and says which — so the App asks about that one, and never guesses from a name.
      const entries = await entriesOf(token, rows, platform, actor);
      return Promise.all(entries.map(async (entry, index) => ({ ...entry, clashWith: await clashOf(token, rows[index]!, files[index]!.name.trim(), actor, (message, data) => platform.warn(message, data)) })));
    },

    /**
     * What saving a file of the workspace takes, gated like opening it read-only: a signed URL
     * for stored bytes, or a document's text as it is now, from the file service (JSON indented) —
     * the read an agent's download makes too (MCP `workspaceDocumentCopy`); `inline_text` is only its
     * last save (B7). Where it goes is the platform's to ask.
     */
    async downloadSource(surface: FileSurface, args: { ref: ChatFileRef }): Promise<DownloadSource> {
      const { token, userId } = await platform.account();
      const row = await readable(surface, { token, userId }, args.ref, 'saving');
      if (row.kind === 'file') return { name: row.filename, kind: 'file', url: await signedUrlOf({ token, userId }, row, { as: surface.asAgent }) };
      try {
        return { name: row.filename, kind: 'text', text: await readDocumentText({ filesUrl: platform.filesUrl, fetch }, token, row.id, surface.asAgent) };
      } catch (error) {
        throw new AppFileError(error instanceof ChatFolderReadError && error.status === 404 ? 'not-found' : 'failed', `${row.filename} could not be read from the file service: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    /**
     * Who is in a chat (摩擦单 F36): what `getContext().chat.members` carries for the chat a page is drawn for, and
     * `gugu.chats.members` for any chat — as the person, or the agent a page or a program's call works for (`asAgent`).
     */
    async members(chatId: string, as: { asAgent?: string | null } = {}): Promise<ChatMember[]> {
      const { token } = await platform.account();
      return membersOfChat(token, chatId, platform, as.asAgent ?? null);
    },

    /**
     * `gugu.chats.list()`: the chats whoever reads is in — the person, or the agent (`asAgent`) — through the door an
     * agent's `message_conversations` takes (`list_my_chats_as`, by the reader's own member rows), most recent first. Its
     * old 1:1 'ai' chats are no `ExtensionChat` and are left out.
     */
    async chats(as: { asAgent?: string | null } = {}): Promise<AppChat[]> {
      const { token, userId } = await platform.account();
      const reader = as.asAgent ?? userId;
      const { data, error } = await chatClient(token).rpc('list_my_chats_as', { p_as_user_id: reader });
      if (error) throw new AppFileError('failed', error.message);
      type Row = { chat_id: string; kind: string; name: string | null; last_message_at: string | null };
      const rows = ((data as Row[] | null) ?? []).filter((row): row is Row & { kind: AppChat['kind'] } => ['group', 'topic', 'dm'].includes(row.kind));
      const peers = await peerNamesOf(token, rows.filter((row) => row.kind === 'dm').map((row) => row.chat_id), reader, platform.identities);
      return rows.map((row) => ({
        id: row.chat_id,
        // A private chat with an agent keeps its name from when it was made (gugu-supabase 20260626114009): the one left
        // when that agent is gone.
        name: (row.kind === 'dm' ? peers.get(row.chat_id) || row.name : row.name) ?? '',
        kind: row.kind,
        lastMessageAt: row.last_message_at,
      }));
    },

    /** A chat as `getContext().chat` carries it (`extensionChatOf`), read as this person. */
    async chat(chatId: string): Promise<ExtensionChat | null> {
      const { token, userId } = await platform.account();
      return extensionChatOf(token, chatId, userId, platform);
    },

    /**
     * 「用 X 打开」: which file, in which chat — gated like saving it. Who opens it is the host's to work out from the
     * claims (file-openers.ts `chooseOpener`).
     */
    async openTarget(surface: FileSurface, args: { ref: ChatFileRef }): Promise<{ chatId: string; itemId: string; name: string; typedName: string; file: ChatPeekFile }> {
      const { token, userId } = await platform.account();
      const row = await readable(surface, { token, userId }, args.ref, 'opening');
      const file = { document: row.kind === 'document', contentType: row.content_type, version: row.version, size: row.size_bytes ?? 0 };
      return { chatId: row.chat_id, itemId: row.id, name: row.filename, typedName: typedFileName({ name: row.filename, contentType: row.content_type }), file };
    },

    /**
     * `gugu.showMessage`: which chat `id` is a message of — any chat the person is in, wherever the page is. Read with
     * the person's own token, so a message they cannot see is not there either. What comes back goes to what shows the
     * chat (it opens that chat, scrolled to the message), never to the page.
     */
    async messageToShow(args: { id: string }): Promise<AppShowMessageDetail> {
      const { token } = await platform.account();
      const messageId = String(args?.id ?? '');
      if (!UUID.test(messageId)) throw new AppFileError('invalid', "Say which message: its id, as a file's sourceMessageIds gives it");
      const { data, error } = await chatClient(token).from('messages').select('id, chat_id').eq('id', messageId).maybeSingle();
      if (error) throw new AppFileError('failed', error.message);
      if (!data) throw new AppFileError('not-found', 'No such message in a chat you are in');
      return { chatId: (data as { chat_id: string }).chat_id, messageId };
    },
  };
}

export type AppFiles = ReturnType<typeof createAppFiles>;
