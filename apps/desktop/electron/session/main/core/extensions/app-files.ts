import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, dialog, shell, type WebContents } from 'electron';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { attachmentFileRef } from '@gugu/core/shared/ui/attachmentModels';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { fetchInChunks } from '@gugu/core/shared/inChunks';
import { writeFileHandle } from '@gugu/core/local/files/fileSnapshots';
import { editorBufferService } from '@main/core/editor/editor-buffer-service';
import {
  AppFileError,
  contentTypeOf,
  createAppFiles,
  requireHandedOr,
  sourceMessageIdsOf,
  tooLargeError,
  type ChatFileRef,
  type FileSurface,
} from '@shared/extensions/app-files-core';
import {
  APP_FILE_MAX_BYTES,
  workspaceAppFileChunk,
  type AppFileChunk,
  fileRefOf,
  fileSearchOf,
  folderOf,
  isWorkspace,
  workspaceSession,
  workspaceTarget,
  placeKey,
  placeOf,
  type AppFileEntry,
  type AppFileOpened,
  type AppFileRef,
  type AppFileText,
  DEFAULT_TEXT_MAX_BYTES,
  type AppForwardFilesDetail,
  type AppFileUpload,
  type AppFileVersion,
  type AppFileVersionContent,
  type WorkspaceFileRef,
  type WorkspacePlace,
  type ChatPeekFile,
  type PeekTarget,
  type PreparedChatFile,
} from '@shared/extensions/app-runtime-protocol';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { currentAccountAccessToken, resolveAccountFile, publishAccountFile } from '@main/core/extensions/account-token';
import { fileServiceUrl, fileSync, localFileService } from '@main/core/extensions/file-sync';
import { createLocalAppFiles, workingCopyEntry, type LocalSurface } from '@main/core/extensions/local-files';
import { REMOTE_WORKSPACE_MAX_FILE_BYTES } from '@gugu/session-core/session-record/contract';
import { workspaceFileText } from '@gugu/core/shared/workspaceUpload.mjs';
import { renderExtensionIcon } from '@main/core/extensions/extension-icon';
import { fileIconKey } from '@shared/extensions/app-icon';
import { claimantOf, openerChoice as chatOpenerChoice, requireOwnTabChoice } from '@shared/extensions/file-openers';
import { sessionHostLocale } from '@main/core/host-locale';
import { localizedManifestText } from '@shared/extensions/catalog';
import { PACKAGE_MESSAGE_SELECT, type PackageMessageRow, type PackageReads } from '@shared/extensions/attachment-install';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { events } from '@main/lib/events';
import { appFileHeardElsewhereChannel, appFileWatchElsewhereChannel, workingCopyMovedChannel } from '@shared/events/appEvents';
import type { ExtensionFileChangeBatch, PlaceVerb } from '@shared/extensions/bridge-protocol';
import { nextPartBytes, SMALLEST_PART_BYTES, uploadInParts } from '@shared/extensions/working-copy-upload';
import { log } from '@main/lib/logger';
import { isValidOpenInAppId } from '@shared/openInApps';

/**
 * The enabled Apps, read once per listing: a list of a hundred files asks for each of its rows in one synchronous pass.
 * Never kept past that pass (摩擦单 F87): an App installed a moment ago names its files in the very next list — kept for
 * a second, the list the install's resync asked for could still name the old claimant, and nothing asked again.
 */
let enabled: { manifest: ExtensionManifest; rootDir: string }[] | null = null;
function enabledApps() {
  if (!enabled) {
    const service = extensionsService();
    enabled = service.list().extensions.filter((entry) => service.isEnabled(entry.manifest.id));
    queueMicrotask(() => {
      enabled = null;
    });
  }
  return enabled;
}
const icons = new Map<string, string | null>();

/** Who opens a chat file of this kind here — the same choice a click makes (摩擦单 F39). */
function claimant(typedName: string) {
  const apps = enabledApps();
  const defaults = extensionsService().openWithDefaults();
  const candidate = claimantOf(typedName, apps.map((app) => app.manifest), 'chat', (key) => defaults[key] ?? null);
  if (!candidate) return null;
  const app = apps.find((entry) => entry.manifest.id === candidate.extensionId);
  const tab = app?.manifest.contributes.tabs.find((entry) => `${candidate.extensionId}.${entry.name}` === candidate.tabKind);
  // The icon the App declared for this kind of file (`fileIcons`, by the claim it matched): none is the generic mark, never its own icon.
  const fileIcon = tab?.fileIcons?.[candidate.suffix];
  const key = `${fileIconKey(candidate.tabKind, candidate.suffix)}@${app?.manifest.version ?? ''}`;
  if (!icons.has(key)) {
    const rendered = app && fileIcon ? renderExtensionIcon(app.rootDir, fileIcon) : null;
    if (rendered && !('dataUrl' in rendered)) log.warn(`Extension ${candidate.extensionId} fileIcons ${candidate.suffix}: ${rendered.reason}`);
    icons.set(key, rendered && 'dataUrl' in rendered ? rendered.dataUrl : null);
  }
  return { suffix: candidate.suffix, state: candidate.state, app: { id: candidate.extensionId, name: localizedManifestText(candidate.app, sessionHostLocale()).name, icon: icons.get(key) ?? null } };
}

/**
 * `gugu.files` on the desktop (真源原则 13): every call names where its file is — a chat's workspace (the shared answers,
 * `app-files-core.ts`, with main's account, capability store and relay) or a session's working copy on this computer
 * (`local-files.ts`). Where the asking page is open plays no part: the only file it may touch without a capability is the
 * one the host handed it (`ctx.file`). Plus what only a desktop has: the system's open and save dialogs.
 */

export { AppFileError, type FileSurface };

/**
 * Who asks, on the desktop: a page (or an App's program), and the one file the host handed it — the file a page was
 * opened for (`ctx.file`), or one an agent handed a program's tool call (F16). `asAgent`: done as that agent — a program's
 * call for it, or a page it works (owner 10-14).
 */
export interface DesktopFilePage {
  takeOpening?: () => PreparedChatFile | undefined;
  pageId: number;
  extensionId: string;
  handed: (AppFileRef & { id: string }) | null;
  asAgent?: string | null;
  /** A page's own chat, as it was bound: already its resource container (`surfaceResourceChat`). */
  boundChat?: string | null;
  /** The active program call stamped by the host; pages have no call. */
  callId?: string;
  signal?: AbortSignal;
}


/** The account signed in here: its token and id; null when nobody is. */
async function signedIn(): Promise<{ token: string; userId: string } | null> {
  const token = await currentAccountAccessToken();
  const userId = token ? userIdFromSupabaseAccessToken(token) : null;
  return token && userId ? { token, userId } : null;
}

/**
 * Who people are: main reads the identity directory with the account's token itself — the page never does. In chunks
 * (`fetchInChunks`, @@@1666): past ~88 ids one `.in()` answers 502, so a group that big had no members at all.
 */
async function accounts(token: string, ids: readonly string[]) {
  const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } });
  return fetchInChunks([...new Set(ids)], async (chunk) => {
    const { data, error } = await client.from('users').select('id, display_name, avatar, type, owner_user_id').in('id', chunk);
    if (error) throw new AppFileError('failed', error.message);
    return (data as { id: string; display_name: string | null; avatar: string | null; type: string | null; owner_user_id: string | null }[] | null) ?? [];
  });
}

const files = createAppFiles({
  resolveFile: resolveAccountFile,
  publishFile: publishAccountFile,
  async account() {
    const me = await signedIn();
    if (!me) throw new AppFileError('failed', 'Not signed in');
    return me;
  },
  hasCapability: (extensionId, capability) => extensionsService().hasCapability(extensionId, capability),
  sync: fileSync,
  claimant,
  async identities(token, ids) {
    return (await accounts(token, ids)).map((user) => ({
      id: user.id,
      name: user.display_name,
      avatar: user.avatar,
      kind: user.type === 'agent' ? ('agent' as const) : ('human' as const),
    }));
  },
  // Faces are drawn in the window (lib/memberFaces.ts); main asks it. Imported when asked: the relay reaches back into
  // the bridge, which reads members from here. No window (gugu server, a window gone): members as they are, no faces.
  async faces(people) {
    const { drawMemberFaces } = await import('@main/core/extensions/extension-bridge-relay');
    return drawMemberFaces(people).catch((error: unknown) => {
      log.warn('[app-files] the window drew no member faces', { error: error instanceof Error ? error.message : String(error) });
      return {};
    });
  },
  filesUrl: fileServiceUrl,
  warn: (message, data) => log.warn(`[app-files] ${message}`, data ?? {}),
});

/** A chat document's place, for the host's own preview of it (`gugu-preview://`, preview-protocol.ts). */
export function chatDocumentPlace(itemId: string) {
  return files.documentPlace(itemId);
}

/** A file that preview's page names beside the document, read as the signed-in person. */
export function besideChatDocument(chatId: string, path: string) {
  return files.besideDocument(chatId, path);
}

/** One account as `identities` reads it, for who published an App package (app-identity.ts `publisherOf`). */
export async function readAccount(id: string) {
  const me = await signedIn();
  if (!me) throw new AppFileError('failed', 'Not signed in');
  return (await accounts(me.token, [id]))[0] ?? null;
}

/**
 * #7290 How main reads a card's message and signs its bytes for an install (`resolveAttachmentPackage`): as the signed-in
 * person — the chat's own rules, a message they cannot read is not there. Asked only for a card by its message.
 */
export const packageReads: PackageReads = {
  async message(messageId) {
    const me = await signedIn();
    if (!me) throw new AppFileError('failed', 'Not signed in');
    const client = createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${me.token}` } });
    const { data, error } = await client.from('messages_view').select(PACKAGE_MESSAGE_SELECT).eq('id', messageId).maybeSingle();
    if (error) throw new AppFileError('failed', error.message);
    return (data as unknown as PackageMessageRow | null) ?? null;
  },
  async open(source) {
    const ref = attachmentFileRef(source);
    if (!ref) return null;
    const file = await resolveAccountFile(ref);
    return file?.status === 'ready' ? file : null;
  },
};

/**
 * Who publishes an App installed from a folder (app-identity.ts): the account signed in as it is installed — an
 * agent's `app_install` runs with its owner's token. Nothing is read; none when nobody is signed in.
 */
export async function folderPublisher(): Promise<{ id: string } | undefined> {
  const me = await signedIn();
  return me ? { id: me.userId } : undefined;
}

const local = createLocalAppFiles({
  service: localFileService,
  sync: fileSync,
  hasCapability: (extensionId, capability) => extensionsService().hasCapability(extensionId, capability),
  self: files.self,
});

/** The chat side of a page: the chat file it was handed, if that is one. */
function chatSurface(page: DesktopFilePage): FileSurface {
  return {
    pageId: page.pageId,
    extensionId: page.extensionId,
    itemId: page.handed && 'chat' in page.handed ? page.handed.id : null,
    asAgent: page.asAgent ?? null,
    ...(page.callId ? { callId: page.callId } : {}),
    ...(page.signal ? { signal: page.signal } : {}),
  };
}

/**
 * The folder on this computer a call names: a session's working copy, found the one way main finds a session's
 * (`agentSessionContext`, as an App tool call's `_meta` does); a project's root folder, the one its sessions run in
 * (`listProjectFolders`). A session not on this computer or with no such folder here, a project not on this computer,
 * is `not-found`; whether anything has opened it since this computer started does not matter. The same files, gates and
 * watch either way: a folder is a folder.
 */
export async function localRootOf(place: WorkspacePlace): Promise<{ workspaceRoot: string; projectId: string; workspaceId: string | null }> {
  const target = workspaceTarget(place);
  if ('project' in target) {
    const { projectRootFolder } = await import('@main/core/projects/operations/project-folders');
    const root = await projectRootFolder(target.project);
    if (!root) throw new AppFileError('not-found', `Project ${target.project} is not a project on this computer`);
    return { workspaceRoot: await fs.realpath(root.path), projectId: target.project, workspaceId: root.workspaceId };
  }
  const { agentSessionContext } = await import('@main/core/extensions/extension-agent-context');
  const session = await agentSessionContext(target.session);
  if (!session?.workspaceRoot) throw new AppFileError('not-found', 'This task has no working folder on this computer');
  return { workspaceRoot: await fs.realpath(session.workspaceRoot), projectId: session.projectId, workspaceId: session.workspaceId ?? null };
}

async function localFolder(page: DesktopFilePage, place: WorkspacePlace): Promise<LocalSurface & { projectId: string; workspaceId: string | null }> {
  const handed = page.handed && isWorkspace(page.handed) && placeKey(page.handed) === placeKey(place) ? page.handed.id : null;
  // Only the key that says where: a file's ref names its place and itself.
  const where: WorkspacePlace = { workspace: place.workspace };
  return { pageId: page.pageId, extensionId: page.extensionId, place: where, filePath: handed, ...(await localRootOf(where)) };
}

const isChat = (ref: AppFileRef): ref is ChatFileRef => !isWorkspace(ref);
const withId = (ref: AppFileRef, what: string): AppFileRef & { id: string } => {
  if (!('id' in ref)) throw new AppFileError('invalid', `${what} takes a file by its id`);
  return ref;
};

/** Whether this is the file the host handed the page: the file its tab names, whether just clicked or restored. */
const isHanded = (page: DesktopFilePage, ref: WorkspaceFileRef): boolean =>
  !!page.handed && isWorkspace(page.handed) && page.handed.workspace === ref.workspace && 'id' in ref && page.handed.id === ref.id;

/** An absolute path reaches one file only: the one the host handed this page. No capability opens any other. */
function checkAbsolute(page: DesktopFilePage, ref: WorkspaceFileRef): void {
  const named = 'id' in ref ? ref.id : ref.name;
  if (path.isAbsolute(named) && !isHanded(page, ref)) {
    throw new AppFileError('denied', 'Not permitted: an absolute path reaches only the file the host handed this page');
  }
}

export async function openAppFile(page: DesktopFilePage, args: { ref?: unknown; readOnly?: boolean; deferDetails?: boolean; expectedVersion?: number }): Promise<AppFileOpened> {
  const ref = fileRefOf(args.ref);
  const readOnly = args.readOnly === true ? { readOnly: true } : {};
  // Outside the working copy there is no live document: it is read and written whole (`readAppFileText`).
  if (!isChat(ref) && path.isAbsolute('id' in ref ? ref.id : ref.name)) {
    checkAbsolute(page, ref);
    return { entry: workingCopyEntry({ workspace: ref.workspace }, 'id' in ref ? ref.id : ref.name, null), docName: '', access: 'ro', self: await files.self(), chunked: true };
  }
  // Another machine's file is read there in pieces (`f.read`), read only, whatever it is: no live document across machines.
  if (!isChat(ref) && await elsewhereGated(page, ref)) {
    const name = 'id' in ref ? ref.id : ref.name;
    return { entry: workingCopyEntry({ workspace: ref.workspace }, name, null), docName: '', access: 'ro', self: await files.self(), chunked: true };
  }
  return isChat(ref)
    ? files.open(chatSurface(page), { ref, ...readOnly, deferDetails: args.deferDetails === true, ...(typeof args.expectedVersion === 'number' ? { expectedVersion: args.expectedVersion } : {}) }, page.takeOpening?.())
    : local.open(await localFolder(page, ref), { ref: ref as WorkspaceFileRef, ...readOnly });
}

/** After `stale-epoch:<n>`: the same file at its new epoch. */
export async function reopenAppFile(page: DesktopFilePage, args: { ref?: unknown; readOnly?: boolean }): Promise<AppFileOpened> {
  const ref = withId(fileRefOf(args.ref), 'reopen');
  const readOnly = args.readOnly === true ? { readOnly: true } : {};
  return isChat(ref)
    ? files.reopen(chatSurface(page), { ref: ref as Extract<ChatFileRef, { id: string }>, ...readOnly })
    : local.reopen(await localFolder(page, ref), { ref: ref as WorkspaceFileRef & { id: string }, ...readOnly });
}

/** Let go of an open file: the grant goes, wherever the file lives. */
export function closeAppFile(page: DesktopFilePage, args: { docName?: string; ref?: ChatFileRef & { version?: number } }): Promise<void> {
  return files.close(chatSurface(page), args);
}

/**
 * The files of a chat the account's revisions named (#7257), as a reader reads them — a person, or an agent its page
 * works as: those still there, and the ids that are not (`groupChange`: `all`, every file of the chat).
 */
export async function changedGroupFiles(chatId: string, asAgent: string | null, wanted: { ids: readonly string[]; all: boolean }): Promise<{ entries: AppFileEntry[]; gone: string[] }> {
  return files.groupChange(chatId, wanted, { asAgent });
}

export async function listAppFiles(page: DesktopFilePage, args: { place?: unknown; folder?: unknown }): Promise<AppFileEntry[]> {
  const place = placeOf(args.place);
  const folder = folderOf(args.folder);
  if ('chat' in place) return files.groupFiles(place.chat, { asAgent: page.asAgent ?? null, ...(folder === undefined ? {} : { folder }) });
  const there = await onItsMachine(page, place, 'filesList', { place, ...(folder === undefined ? {} : { folder }) });
  if (there.there) return there.value as AppFileEntry[];
  const { listWorkingCopy } = await import('./working-copy-files');
  return listWorkingCopy(place, folder, page.pageId);
}

/** `f.read(offset, length)`: a pinned chat snapshot or a working copy, through the same range packet. */
export async function readAppFile(page: DesktopFilePage, args: { ref?: unknown; offset?: unknown; length?: unknown }): Promise<AppFileChunk> {
  const ref = fileRefOf(args.ref);
  const offset = Number(args.offset ?? 0);
  const length = Number(args.length ?? 0);
  if (isChat(ref)) return files.read(chatSurface(page), { ref: { ...ref, version: (args.ref as { version?: number })?.version }, offset, length });
  checkAbsolute(page, ref);
  return workspaceAppFileChunk(await workingCopyPiece(page, ref, offset, length));
}

/** A piece of a working copy's file, on the machine it is on. */
async function workingCopyPiece(page: DesktopFilePage, ref: WorkspaceFileRef, offset: number, length: number) {
  const there = await onItsMachine(page, ref, 'filesRead', { ref, offset, length });
  if (there.there) return there.value as { size: number; etag: string; offset: number; data: string };
  const { readWorkingCopy } = await import('./working-copy-files');
  return readWorkingCopy(ref, 'id' in ref ? ref.id : ref.name, offset, length);
}

/** What a page may do to a working copy's file, and that it names no absolute path it was not handed. */
function mayTouch(page: DesktopFilePage, ref: WorkspaceFileRef, capabilities: readonly ('files:read' | 'files:write')[], what: string): void {
  checkAbsolute(page, ref);
  requireHandedOr(isHanded(page, ref), (capability) => extensionsService().hasCapability(page.extensionId, capability), capabilities, what);
}

/**
 * What every way of reading a working copy's file or folder passes: the file the page may read, on a machine it may reach.
 * A call whose door says `needs: null` (it may be a chat's file) has no other gate, and what runs behind it reads unchecked.
 */
async function mayRead(page: DesktopFilePage, ref: WorkspaceFileRef, what: string): Promise<void> {
  mayTouch(page, ref, ['files:read', 'files:write'], what);
  await elsewhereGated(page, ref);
}

/** The file a whole-file call names, and that it may: the one handed to the page needs nothing, any other `capability`. */
function wholeFileRef(page: DesktopFilePage, value: unknown, capability: 'files:read' | 'files:write', what: string): WorkspaceFileRef & { id: string } {
  const ref = withId(fileRefOf(value), what);
  if (isChat(ref)) throw new AppFileError('invalid', `${what} takes a working copy's file: a chat's opens live (files.open)`);
  mayTouch(page, ref, [capability], `${what} on`);
  return ref as WorkspaceFileRef & { id: string };
}

/**
 * One version of a working copy's file, piece after piece, on the machine it is on: the one reading of a whole file. Changed
 * while it is read, pieces of two versions are neither: `begin` hears it read once more from the start, and still moving is said.
 */
async function readOneVersion(page: DesktopFilePage, ref: WorkspaceFileRef, reader: {
  /** Before the first piece of each try. `false`: not read at all. */
  begin(size: number): boolean | void | Promise<boolean | void>;
  piece(bytes: Uint8Array<ArrayBuffer>, at: number, size: number): void | Promise<void>;
  signal?: AbortSignal;
}): Promise<{ size: number; etag: string } | null> {
  for (let attempt = 0; ; attempt++) {
    let at = 0;
    let part = SMALLEST_PART_BYTES;
    let started = Date.now();
    if (reader.signal?.aborted) throw stopped();
    let next = await workingCopyPiece(page, ref, 0, part);
    const { size, etag } = next;
    if (await reader.begin(size) === false) return null;
    let moved = false;
    for (;;) {
      const bytes = workspaceAppFileChunk(next).data;
      if (bytes.byteLength > 0) {
        at += bytes.byteLength;
        await reader.piece(bytes, at, size);
      }
      if (at >= size || bytes.byteLength === 0) break;
      if (reader.signal?.aborted) throw stopped();
      part = nextPartBytes(part, Date.now() - started);
      started = Date.now();
      next = await workingCopyPiece(page, ref, at, part);
      if (next.etag !== etag) { moved = true; break; }
    }
    if (!moved) return { size, etag };
    if (attempt > 0) throw new AppFileError('content-changed', `${pathOfRef(ref)} keeps changing on its computer while it is read`);
  }
}

const versionKey = (ref: WorkspaceFileRef & { id: string }) => `${ref.workspace}\0${ref.id}`;

/**
 * `files.readText(file, { maxBytes })`: a working copy's text whole, in the file panel's pieces, on the machine it is on.
 * What it holds is the one answer to "is this text" (`workspaceFileText`); over `maxBytes` it is not read, only sized.
 */
export async function readAppFileText(page: DesktopFilePage, args: { ref?: unknown; maxBytes?: unknown; transferId?: unknown }, onProgress?: (transferId: string, done: number, total: number) => void): Promise<AppFileText> {
  const ref = wholeFileRef(page, args.ref, 'files:read', 'readText');
  const { readVersions } = await import('./working-copy-files');
  const maxBytes = typeof args.maxBytes === 'number' ? Math.min(args.maxBytes, REMOTE_WORKSPACE_MAX_FILE_BYTES) : DEFAULT_TEXT_MAX_BYTES;
  const entry = workingCopyEntry({ workspace: ref.workspace }, ref.id, null);
  let pieces: Uint8Array[] = [];
  let tooLarge = 0;
  const read = await readOneVersion(page, ref, {
    begin(size) {
      pieces = [];
      if (size <= maxBytes) return;
      tooLarge = size;
      return false;
    },
    piece(bytes, at, size) {
      pieces.push(bytes);
      if (typeof args.transferId === 'string') onProgress?.(args.transferId, at, size);
    },
  });
  if (!read) return { entry: { ...entry, size: tooLarge }, content: '', truncated: true, totalSize: tooLarge };
  if (!readVersions.has(page.pageId)) readVersions.set(page.pageId, new Map());
  readVersions.get(page.pageId)!.set(versionKey(ref), read.etag);
  const text = workspaceFileText(ref.id, Buffer.concat(pieces));
  return { entry: { ...entry, size: read.size }, content: text?.text ?? '', ...(text ? { exact: text.exact } : { binary: true as const }), truncated: false, totalSize: read.size };
}

/**
 * `files.writeText(file, text)`: a working copy's text whole, in the upload's parts, checked on its machine against the
 * version this page read: `content-changed` when the disk moved on. A file deleted meanwhile is simply made again, as
 * saving does in an editor.
 */
export async function writeAppFileText(page: DesktopFilePage, args: { ref?: unknown; text?: unknown }): Promise<{ entry: AppFileEntry }> {
  const ref = wholeFileRef(page, args.ref, 'files:write', 'writeText');
  const { readVersions } = await import('./working-copy-files');
  if (typeof args.text !== 'string') throw new AppFileError('invalid', 'writeText(file, text) takes the text');
  const content = new Blob([args.text]);
  const read = readVersions.get(page.pageId)?.get(versionKey(ref)) ?? null;
  let etag: string | undefined;
  const send = (expectedEtag: string | null) => uploadInParts(async (part) => {
    const answer = await writeAppFileChunk(page, part) as { received: number; entry?: AppFileEntry; etag?: string };
    etag = answer.etag ?? etag;
    return answer;
  }, { workspace: ref.workspace }, [{ name: ref.id, blob: content }], undefined, { expectedEtag });
  const [entry] = await send(read).catch(async (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'content-changed' && !(await appFileExists(page, { ref }))) return send(null);
    // Written without reading it first, and it is there: what it holds was never seen.
    if (code === 'name-taken') throw new AppFileError('content-changed', `${ref.id} is there already: read it first`);
    throw error;
  });
  if (!readVersions.has(page.pageId)) readVersions.set(page.pageId, new Map());
  readVersions.get(page.pageId)!.set(versionKey(ref), etag!);
  return { entry: entry! };
}

const watchesElsewhere = new Map<string, (change: ExtensionFileChangeBatch) => void>();
let hearingElsewhere = false;

/**
 * `files.onChanged({ workspace, id }, fn)`: one file. On its own computer from the change feed; on another, from the event
 * that machine's file changes already reach the window as (`app-file-watches-elsewhere`).
 */
export async function watchAppFile(page: DesktopFilePage, value: unknown, hear: (change: ExtensionFileChangeBatch) => void): Promise<() => void> {
  const ref = wholeFileRef(page, value, 'files:read', 'onChanged');
  if (!(await elsewhereGated(page, ref))) {
    const { watchWorkingCopyFile } = await import('./working-copy-files');
    return watchWorkingCopyFile(ref, ref.id, hear);
  }
  return hearElsewhere(workspaceSession(ref)!, { file: ref.id }, hear);
}

/** `files.onChanged({ workspace, folder }, fn)`: what changed below a folder, on a machine the page may reach. */
export async function watchAppFolder(page: DesktopFilePage, place: WorkspacePlace, folder: string | undefined, hear: (change: ExtensionFileChangeBatch) => void): Promise<() => void> {
  await elsewhereGated(page, place);
  const { watchWorkingCopy } = await import('./working-copy-files');
  return watchWorkingCopy(place, folder, hear);
}

/** A file or folder of a session on another machine: its changes reach the window only, so main asks the window to tell it. */
export function hearElsewhere(sessionId: string, what: { file: string } | { folder: string }, hear: (change: ExtensionFileChangeBatch) => void): () => void {
  if (!hearingElsewhere) {
    hearingElsewhere = true;
    events.on(appFileHeardElsewhereChannel, ({ key, change }) => watchesElsewhere.get(key)?.(change));
  }
  const key = randomUUID();
  watchesElsewhere.set(key, hear);
  events.emit(appFileWatchElsewhereChannel, { key, sessionId, ...what, on: true });
  return () => {
    watchesElsewhere.delete(key);
    events.emit(appFileWatchElsewhereChannel, { key, sessionId, ...what, on: false });
  };
}

/** `files.exists(file)`: whether a working copy's file is there now, on the machine it is on. */
export async function appFileExists(page: DesktopFilePage, args: { ref?: unknown }): Promise<boolean> {
  const ref = wholeFileRef(page, args.ref, 'files:read', 'exists');
  return workingCopyPiece(page, ref, 0, 0).then(() => true, (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'not-found' || code === 'invalid') return false;
    throw error;
  });
}

/**
 * `files.draft`: a file's unsaved edits, on the machine the file is on, under the key its old editor used there too: its own
 * table, project and workspace, and its path in the working copy, so what that editor left is found.
 */
export async function appFileDraft(page: DesktopFilePage, args: { ref?: unknown; text?: unknown }): Promise<string | null | void> {
  const ref = wholeFileRef(page, args.ref, 'files:read', 'draft');
  const there = await onItsMachine(page, ref, 'filesDraft', { ref, ...(args.text === undefined ? {} : { text: args.text }) });
  if (there.there) return there.value as string | null;
  return draftHere(ref, args.text);
}

/** On this machine: the page that named the file was let through where it is. */
export async function draftHere(ref: WorkspaceFileRef & { id: string }, text: unknown): Promise<string | null | void> {
  const { projectId, workspaceId, workspaceRoot } = await localRootOf({ workspace: ref.workspace });
  const workspace = workspaceId ?? ref.workspace;
  const inRoot = path.relative(workspaceRoot, ref.id);
  const filePath = path.isAbsolute(ref.id) && !inRoot.startsWith('..') && !path.isAbsolute(inRoot) ? inRoot.split(path.sep).join('/') : ref.id;
  // Kept under either spelling of the path: the built-in editor this replaced also wrote absolute ones.
  const buffers = (await editorBufferService.listBuffers(projectId, workspace)).filter((buffer) => path.resolve(workspaceRoot, buffer.filePath) === path.resolve(workspaceRoot, filePath));
  if (text === undefined) return buffers[0]?.content ?? null;
  await Promise.all(buffers.map((buffer) => editorBufferService.clearBuffer(projectId, workspace, buffer.filePath)));
  if (text !== null) await editorBufferService.saveBuffer(projectId, workspace, filePath, String(text));
}

/**
 * Whether a working copy is a session's on another of the person's machines — whose files only an App with
 * `files:read:all-machines` reads (list, pieces, open, save). Refused, said why, without it; false for this computer's.
 */
async function elsewhereGated(page: DesktopFilePage, place: WorkspacePlace): Promise<boolean> {
  if (!(await sessionElsewhere(place))) return false;
  if (!extensionsService().hasCapability(page.extensionId, 'files:read:all-machines')) {
    throw new AppFileError('denied', 'Not permitted: a working copy on another of your computers needs "files:read:all-machines"');
  }
  return true;
}

/** A session's working copy on another of the person's machines, and that session's project there; null for this computer's. */
async function sessionElsewhere(place: WorkspacePlace): Promise<{ sessionId: string; projectId: string | null; deviceId: string } | null> {
  const sessionId = workspaceSession(place);
  if (!sessionId) return null;
  const { sessionMachine } = await import('./app-programs-elsewhere');
  const machine = await sessionMachine(sessionId);
  return machine ? { sessionId, projectId: machine.projectId, deviceId: machine.deviceId } : null;
}

/**
 * A working copy's file call (`machine: 'place'`) for a session on another of the person's machines: done there, by the
 * same `machineVerbs` that machine's own pages reach. `{ there: false }` for a working copy on this computer.
 */
async function onItsMachine(page: DesktopFilePage, place: WorkspacePlace, method: PlaceVerb, args: Record<string, unknown>) {
  const session = workspaceSession(place);
  if (!session) return { there: false } as const;
  if (!(await elsewhereGated(page, place))) return { there: false } as const;
  const { callOnSessionMachine } = await import('./app-programs-elsewhere');
  const manifest = extensionsService().get(page.extensionId).manifest;
  return callOnSessionMachine({ extensionId: page.extensionId, manifest }, session, method, args, page.asAgent != null);
}

/** Across every chat whoever the page works as is in (`files:read`, checked at the door): by a piece of the path; opened last. */
export async function appFileViewPreferences(page: DesktopFilePage, args: { place?: unknown; showAppData?: boolean }) {
  const place = placeOf(args.place);
  if (!('chat' in place)) throw new AppFileError('invalid', 'Folder preferences belong to a chat');
  return files.viewPreferences(place.chat, args.showAppData, page.asAgent ? null : page.boundChat);
}

export async function searchAppFiles(page: DesktopFilePage, args: unknown): Promise<AppFileEntry[]> {
  return files.search(fileSearchOf(args), { asAgent: page.asAgent ?? null });
}

export async function recentAppFiles(page: DesktopFilePage, args: unknown): Promise<AppFileEntry[]> {
  const { limit } = fileSearchOf(args);
  return files.recent(limit === undefined ? {} : { limit }, { asAgent: page.asAgent ?? null });
}

/** A name in a working copy's folder: its path there. */
const inFolder = (folder: string | undefined, name: string) => path.posix.join((folder ?? '').replace(/^\/+/, ''), name);

/** What shows a working copy's file follows it, wherever the call was made: on this computer, its own panes. */
function movedInWorkingCopy(ref: AppFileRef, from: string, to: string | null): void {
  if (isWorkspace(ref)) events.emit(workingCopyMovedChannel, { workspace: ref.workspace, from, to });
}
const pathOfRef = (ref: AppFileRef) => ('id' in ref ? ref.id : ref.name);

/** A4 A working copy's file comes from no message: one asked to is refused, said why — never written without them. */
function noSourceMessagesInWorkingCopy(sourceMessageIds: unknown): void {
  if (sourceMessageIdsOf(sourceMessageIds).length > 0) {
    throw new AppFileError('invalid', "A working copy's file comes from no message: sourceMessageIds is for a chat's files");
  }
}

export async function createAppFile(
  page: DesktopFilePage,
  args: { place?: unknown; name: string; content: string; contentType?: string; sourceMessageIds?: unknown; folder?: unknown },
): Promise<AppFileEntry> {
  const place = placeOf(args.place);
  const file = { name: args.name, content: args.content, ...(args.contentType ? { contentType: args.contentType } : {}) };
  if ('chat' in place) return files.create(place.chat, { ...file, sourceMessageIds: args.sourceMessageIds, folder: args.folder }, { asAgent: page.asAgent ?? null, extensionId: page.extensionId });
  noSourceMessagesInWorkingCopy(args.sourceMessageIds);
  const named = { ...file, name: inFolder(folderOf(args.folder), args.name) };
  const there = await onItsMachine(page, place, 'filesCreate', { place, ...named });
  if (there.there) return there.value as AppFileEntry;
  return local.create(await localFolder(page, place), named);
}

export async function renameAppFile(page: DesktopFilePage, args: { ref?: unknown; name: string }): Promise<AppFileEntry> {
  const ref = fileRefOf(args.ref);
  if (isChat(ref)) return files.rename(chatSurface(page), { ref, name: args.name });
  const there = await onItsMachine(page, ref, 'filesRename', { ref, name: args.name });
  const entry = there.there ? there.value as AppFileEntry : await local.rename(await localFolder(page, ref), { ref: ref as WorkspaceFileRef, name: args.name });
  movedInWorkingCopy(ref, pathOfRef(ref), entry.id);
  return entry;
}

/** 「设为临时 / 一直保留」: a chat file's cloud copy (a working copy's file has none). */
export async function keepAppFile(page: DesktopFilePage, args: { refs?: unknown; how?: unknown }): Promise<{ changed: number }> {
  const refs = (Array.isArray(args.refs) ? args.refs : []).map((ref) => fileRefOf(ref));
  if (refs.some((ref) => !isChat(ref))) throw new AppFileError('invalid', "A working copy's file has no cloud copy to keep");
  return files.keep(chatSurface(page), { refs: refs as ChatFileRef[], how: args.how });
}

/** 子文件夹: a chat's folder at `path`, made all the way down (one already there is answered as it is). */
export async function makeAppFolder(page: DesktopFilePage, args: { place?: unknown; path?: unknown }): Promise<AppFileEntry> {
  const place = placeOf(args.place);
  if ('chat' in place) return files.mkdir(place.chat, { path: args.path }, { asAgent: page.asAgent ?? null });
  const there = await onItsMachine(page, place, 'filesMkdir', { place, path: args.path });
  if (there.there) return there.value as AppFileEntry;
  return local.mkdir(await localFolder(page, place), { path: String(args.path ?? '') });
}

/** 子文件夹: a chat's file or folder into another folder, renamed too when `name` is given. */
export async function moveAppFile(page: DesktopFilePage, args: { ref?: unknown; folder?: unknown; name?: unknown }): Promise<AppFileEntry> {
  const ref = fileRefOf(args.ref);
  if (isChat(ref)) return files.move(chatSurface(page), { ref, folder: args.folder, name: args.name });
  const target = { ...(args.folder === undefined ? {} : { folder: folderOf(args.folder) }), ...(typeof args.name === 'string' ? { name: args.name } : {}) };
  const there = await onItsMachine(page, ref, 'filesMove', { ref, ...target });
  const entry = there.there ? there.value as AppFileEntry : await local.move(await localFolder(page, ref), { ref: ref as WorkspaceFileRef, ...target });
  movedInWorkingCopy(ref, pathOfRef(ref), entry.id);
  return entry;
}

export async function removeAppFile(page: DesktopFilePage, args: { ref?: unknown }): Promise<void> {
  const ref = fileRefOf(args.ref);
  if (isChat(ref)) return files.remove(chatSurface(page), { ref });
  const there = await onItsMachine(page, ref, 'filesRemove', { ref });
  if (!there.there) await local.remove(await localFolder(page, ref), { ref: ref as WorkspaceFileRef });
  movedInWorkingCopy(ref, pathOfRef(ref), null);
}

/** One part of a file going into a working copy, on the machine it is on (`files.upload` with bytes). */
export async function writeAppFileChunk(page: DesktopFilePage, args: Record<string, unknown>): Promise<unknown> {
  const place = placeOf(args.place);
  if ('chat' in place) throw new AppFileError('invalid', "A chat's file is uploaded whole: files.upload");
  checkAbsolute(page, { ...place, id: String(args.path) });
  const there = await onItsMachine(page, place, 'filesWriteChunk', args);
  if (there.there) return there.value;
  const { writeWorkingCopyChunk } = await import('./working-copy-files');
  return writeWorkingCopyChunk(place, args as never);
}

/** A working copy's file or folder in this computer's file manager (another machine's has none here). */
export async function revealAppFile(page: DesktopFilePage, args: { ref?: unknown }): Promise<void> {
  const ref = fileRefOf(args.ref);
  if (isChat(ref)) throw new AppFileError('invalid', "A chat's file is on no folder of this computer");
  shell.showItemInFolder(await localPathOf(page, ref, 'revealing'));
}

/** Where a working copy's file or folder is on this computer, for what hands it to another program; it passes what reading it does. */
async function localPathOf(page: DesktopFilePage, ref: WorkspaceFileRef, what: string, follow = false): Promise<string> {
  if (await sessionElsewhere(ref)) throw new AppFileError('invalid', 'This file is on another computer');
  await mayRead(page, ref, what);
  return local.localPath(await localFolder(page, ref), { ref, follow });
}

/** The programs a working copy's file can be opened in on this computer. */
export async function appOpenInApps(): Promise<Array<{ id: string; label: string }>> {
  const { appService } = await import('@main/core/app/service');
  return appService.openInMenu();
}

/** 「用 VS Code 打开」: a working copy's file or folder in a program of this computer, as the project's tab menu opens the project. */
export async function openAppFileIn(page: DesktopFilePage, args: { ref?: unknown; app?: unknown }): Promise<void> {
  const ref = fileRefOf(args.ref);
  if (isChat(ref)) throw new AppFileError('invalid', "A chat's file is on no folder of this computer");
  if (!isValidOpenInAppId(args.app)) throw new AppFileError('invalid', 'Say which program, as files.openInApps lists it');
  const target = await localPathOf(page, ref, 'opening', true);
  const { appService } = await import('@main/core/app/service');
  await appService.openIn({ app: args.app, path: target }).catch((error: unknown) => {
    throw new AppFileError('failed', error instanceof Error ? error.message : String(error));
  });
}

/** A file's next content (G1): a chat's stored file becomes its next version; a working copy's file is written over. */
export async function replaceAppFile(page: DesktopFilePage, args: { ref?: unknown; file?: unknown; expectedVersion?: unknown }): Promise<AppFileEntry> {
  const ref = fileRefOf(args.ref);
  const file = args.file as AppFileUpload;
  const expectedVersion = (args.expectedVersion ?? null) as number | null;
  if (isChat(ref)) return files.replace(chatSurface(page), { ref, file, expectedVersion });
  if (expectedVersion !== null) throw new AppFileError('invalid', "A working copy's file has no versions here: replace it without expectedVersion");
  return local.replace(await localFolder(page, ref), { ref: ref as WorkspaceFileRef, file });
}

/**
 * Whether whoever reads may delete each file, in the order asked: a chat file's answer is the database's (its delete's own
 * rule); a working copy's is what the App may do: `files:write`, wherever the working copy is.
 */
export async function appFilesCanDelete(page: DesktopFilePage, args: { refs?: unknown }): Promise<boolean[]> {
  const refs = (Array.isArray(args.refs) ? args.refs : []).map((ref) => fileRefOf(ref));
  const chat = await files.canDelete(chatSurface(page), { refs: refs.filter(isChat) });
  let next = 0;
  const mayWrite = extensionsService().hasCapability(page.extensionId, 'files:write');
  return refs.map((ref) => (isChat(ref) ? chat[next++]! : mayWrite));
}

/** G2 A chat file's kept versions. A working copy's history is its own (git): not kept here, said so. */
export async function appFileVersions(page: DesktopFilePage, args: { ref?: unknown }): Promise<AppFileVersion[]> {
  const ref = fileRefOf(args.ref);
  if (!isChat(ref)) throw new AppFileError('invalid', "A working copy's file keeps no versions here: its history is the working copy's own");
  return files.versions(chatSurface(page), { ref });
}

export async function readAppFileVersion(page: DesktopFilePage, args: { ref?: unknown; n?: unknown }): Promise<AppFileVersionContent> {
  const ref = fileRefOf(args.ref);
  if (!isChat(ref)) throw new AppFileError('invalid', "A working copy's file keeps no versions here: its history is the working copy's own");
  return files.readVersion(chatSurface(page), { ref, n: Number(args.n) });
}

/** Into a chat's workspace or a session's working copy, as the call names it. */
export async function uploadAppFiles(
  page: DesktopFilePage,
  place: unknown,
  uploads: readonly AppFileUpload[],
  sourceMessageIds?: unknown,
  folder?: unknown,
  keep?: unknown,
): Promise<AppFileEntry[]> {
  const where = placeOf(place);
  // A program acting for an agent uploads as that agent (G5): the chat's door judges the agent, the rows are its.
  if ('chat' in where) return files.upload(where.chat, uploads, { asAgent: page.asAgent ?? null, sourceMessageIds, folder, keep });
  noSourceMessagesInWorkingCopy(sourceMessageIds);
  return uploadInParts((part) => writeAppFileChunk(page, part) as never, where, uploads.map((file) => ({ name: file.name, blob: new Blob([file.bytes]) })), folderOf(folder));
}

export const messageToShow = files.messageToShow;

/** What a forward holds in memory at once, with a File and a copy for the send on top of it. Past it: said, before it is read. */
export const FORWARD_MAX_BYTES = 512 * 1024 * 1024;

/**
 * `files.forward`: a chat's files go by reference. A working copy's file is in no chat to refer to, so what it holds goes:
 * read here, on the machine it is on, so one that cannot be read is said before anyone picks a chat.
 */
export async function forwardTargets(page: DesktopFilePage, args: { refs?: unknown; transferId?: unknown }, report?: (transferId: string, done: number, total: number) => void): Promise<AppForwardFilesDetail> {
  if (!Array.isArray(args.refs)) throw new AppFileError('invalid', 'files.forward(files): give one file or more');
  const refs = args.refs.map(fileRefOf);
  const chatRefs = refs.filter(isChat);
  if (chatRefs.length === refs.length) return files.forwardTargets(chatSurface(page), { refs: chatRefs });
  if (chatRefs.length > 0) throw new AppFileError('invalid', 'files.forward(files): the files are of one place');
  for (const ref of refs) await mayRead(page, ref as WorkspaceFileRef, 'forwarding');
  // A transfer the page follows and can stop, as a download is.
  const transferId = typeof args.transferId === 'string' ? args.transferId : null;
  const stop = new AbortController();
  const key = downloadKey(page, transferId);
  if (transferId) downloads.set(key, stop);
  try {
    const copies: Array<{ name: string; bytes: Uint8Array<ArrayBuffer> }> = [];
    let held = 0;
    for (const ref of refs) {
      const bytes = await wholeWorkingCopyFile(page, ref as WorkspaceFileRef, FORWARD_MAX_BYTES - held, stop.signal, (done, size) => { if (transferId) report?.(transferId, done, size); });
      held += bytes.byteLength;
      copies.push({ name: path.posix.basename(pathOfRef(ref as WorkspaceFileRef)), bytes });
    }
    return { copies };
  } finally {
    downloads.delete(key);
  }
}
export const chatMembersOf = files.members;
export const chatsOf = files.chats;
export const surfaceChatOf = files.chat;
export const resourceChatOf = files.resourceChat;
export const chatOfItem = files.chatOf;
export const groupFiles = files.groupFiles;
export const groupFile = files.groupFile;

/** API 14 `chatFile`: the file an App opened in this chat shows, as that file opened with it (made the first time). */
export function appChatFile(chatId: string, extensionId: string) {
  const service = extensionsService();
  const manifest = service.list().extensions.find((entry) => entry.manifest.id === extensionId && service.isEnabled(extensionId))?.manifest;
  return files.appChatFile(chatId, manifest);
}

/**
 * Who opens a chat file of this kind: the most specific claim, or the person's 「始终用它」 — what a click opens; with
 * `ask`, every App that opens it, for the person to pick (「用别的 App 打开」, 摩擦单 F2); `none` when nobody here does —
 * the group's panel offers the App that would (161 10-15). One answer for a page's `gugu.files.openWith` and the shell's
 * own ways in (an App card's 「Open」, a file link).
 */
export function openerChoice(typedName: string, ask = false) {
  const manifests = enabledApps().map((entry) => entry.manifest);
  const defaults = extensionsService().openWithDefaults();
  return chatOpenerChoice(typedName, manifests, 'chat', (key) => defaults[key] ?? null, ask);
}

/** A page's own claiming tab uses the same enabled Apps, without reading openWithDefaults. */
export function ownTabChoice(typedName: string, extensionId: string, tab: string) {
  return requireOwnTabChoice(typedName, enabledApps().map((entry) => entry.manifest), 'chat', extensionId, tab);
}

/**
 * 「用 X 打开」, gated like saving the file: a chat file — who opens it, for the window that shows the chat to open
 * (`AppOpenWithDetail`); a session's working-copy file — which file of which session, for the window that shows the page
 * to open in that session's pane the way a click there does (the same resolver, on this computer or another: the window
 * reaches the session's machine as its own file panel does). Beside the page (`peek`, G1), and always for a project's file
 * (no session's pane holds it): which file in which workspace, for the window to open in the page's own slot.
 */
export async function openWithTarget(
  page: DesktopFilePage,
  args: { ref?: unknown; ask?: boolean; peek?: boolean },
): Promise<
  | { kind: 'chat'; target: { chatId: string; itemId: string; name: string; typedName: string; file: ChatPeekFile; opening?: PreparedChatFile } }
  | { kind: 'session'; target: { sessionId: string; projectId: string | null; deviceId: string | null; path: string; ask: boolean } }
  | { kind: 'peek'; target: Extract<PeekTarget, { kind: 'local' }> }
> {
  const ref = fileRefOf(args.ref);
  if (isChat(ref)) return { kind: 'chat', target: await files.openTarget(chatSurface(page), { ref }) };
  const name = 'id' in ref ? ref.id : ref.name;
  const ask = args.ask === true;
  // A session's working copy on another machine: gated as opening it read-only (the file the page was handed needs nothing).
  const elsewhere = await sessionElsewhere(ref);
  if (elsewhere) {
    mayTouch(page, ref, ['files:read', 'files:write'], 'opening');
    return { kind: 'session', target: { sessionId: elsewhere.sessionId, projectId: elsewhere.projectId, deviceId: elsewhere.deviceId, path: name, ask } };
  }
  const copy = await localFolder(page, ref);
  const found = await local.openTarget(copy, { ref: ref as WorkspaceFileRef });
  const session = workspaceSession(found.place);
  if (args.peek || !session) {
    if (!copy.workspaceId) throw new AppFileError('not-found', `${found.name} is in no workspace this computer has open`);
    const { place } = found;
    return { kind: 'peek', target: { kind: 'local', place, projectId: copy.projectId, workspaceId: copy.workspaceId, path: found.path, absolutePath: path.join(copy.workspaceRoot, found.path), name: found.name, ask } };
  }
  return { kind: 'session', target: { sessionId: session, projectId: copy.projectId, deviceId: null, path: found.path, ask } };
}

/**
 * What the person picks in the host's own file picker (reached only inside their gesture, which
 * the preload checked). Cancelled is an empty list. Sizes are checked before anything is read.
 */
export async function pickFilesToUpload(owner: WebContents | null): Promise<AppFileUpload[]> {
  const window = owner ? BrowserWindow.fromWebContents(owner) : null;
  const options = { properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] };
  const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  if (picked.canceled) return [];
  const sizes = await Promise.all(picked.filePaths.map(async (file) => ({ file, size: (await fs.stat(file)).size })));
  const tooLarge = sizes.filter(({ size }) => size > APP_FILE_MAX_BYTES).map(({ file }) => path.basename(file));
  if (tooLarge.length > 0) throw tooLargeError(tooLarge);
  return Promise.all(
    sizes.map(async ({ file }) => {
      const bytes = await fs.readFile(file);
      return {
        name: path.basename(file),
        contentType: contentTypeOf(file),
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      };
    }),
  );
}

/**
 * Save a file to disk, where the person says in the host's save dialog (inside their gesture) — a chat's or a working
 * copy's, as the call names it. Gated like opening it read-only — checked before the dialog shows. Cancelled is `false`,
 * not an error.
 */
type SaveSource = Awaited<ReturnType<typeof files.downloadSource>> | { name: string; ref: WorkspaceFileRef; page: DesktopFilePage; kind: 'pieces' };

async function downloadSourceOf(page: DesktopFilePage, given: unknown): Promise<SaveSource> {
  const ref = fileRefOf(given);
  if (isChat(ref)) return await files.downloadSource(chatSurface(page), { ref });
  // A working copy's file, wherever it is, one piece after another. Here a file that is not there is said before the save dialog.
  await mayRead(page, ref, 'saving');
  if (!path.isAbsolute(pathOfRef(ref)) && !(await sessionElsewhere(ref))) await local.openTarget(await localFolder(page, ref), { ref });
  return { name: path.posix.basename(pathOfRef(ref)), ref, page, kind: 'pieces' as const };
}

/** What a download under way reports, and what stops it. */
type Saving = { signal?: AbortSignal; saved?: (bytes: number, size: number) => void };
const stopped = () => new AppFileError('invalid', 'The download was stopped');

/** All of a working copy's file in one buffer, up to `max`: pieces kept until the end would hold it twice. */
async function wholeWorkingCopyFile(page: DesktopFilePage, ref: WorkspaceFileRef, max: number, signal: AbortSignal, heard: (done: number, size: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  let whole = new Uint8Array(0);
  await readOneVersion(page, ref, {
    signal,
    begin(size) {
      if (size > max) throw new AppFileError('too-large', `${pathOfRef(ref)} is ${size} bytes; at most ${FORWARD_MAX_BYTES} are forwarded at once`);
      whole = new Uint8Array(size);
    },
    piece(bytes, at, size) {
      whole.set(bytes, at - bytes.byteLength);
      heard(at, size);
    },
  });
  return whole;
}

/** A working copy's file on the disk, each piece as it comes: half of one, or pieces of two versions, are not left behind. */
async function savePieces(page: DesktopFilePage, ref: WorkspaceFileRef, filePath: string, saving: Saving = {}): Promise<void> {
  const out = await fs.open(filePath, 'w');
  try {
    let told = 0;
    await readOneVersion(page, ref, {
      ...(saving.signal ? { signal: saving.signal } : {}),
      async begin(size) {
        await out.truncate(0);
        if (told) saving.saved?.(-told, size);
        told = 0;
      },
      async piece(bytes, at, size) {
        await out.write(bytes, 0, bytes.byteLength, at - bytes.byteLength);
        told += bytes.byteLength;
        saving.saved?.(bytes.byteLength, size);
      },
    });
  } catch (error) {
    await out.close();
    await fs.rm(filePath, { force: true });
    throw error;
  }
  await out.close();
}

/** At most this many files in a folder saved at once: past it, said, never a list that goes on without end. */
const FOLDER_DOWNLOAD_MAX_FILES = 10_000;

/** A working copy's folder saved under `target`, wherever the working copy is: listed first (how much there is), then one piece at a time. */
async function saveFolder(page: DesktopFilePage, place: WorkspacePlace, folder: string, target: string, report: (done: number, total: number) => void, signal: AbortSignal): Promise<string[]> {
  const found: { id: string; to: string; size: number; link: boolean }[] = [];
  // What a link points at may be nowhere, or outside: it is not the folder's. Those are left out and said, never the reason the rest is lost.
  const skipped: string[] = [];
  const walk = async (from: string, to: string): Promise<void> => {
    if (signal.aborted) throw stopped();
    await fs.mkdir(to, { recursive: true });
    for (const entry of await listAppFiles(page, { place, folder: from })) {
      if (entry.type === 'folder') {
        // Followed, a link to a folder above it never ends.
        if (entry.symlink) skipped.push(entry.id);
        else await walk(entry.id, path.join(to, entry.name));
        continue;
      }
      found.push({ id: entry.id, to: path.join(to, entry.name), size: entry.size ?? 0, link: !!entry.symlink });
      if (found.length > FOLDER_DOWNLOAD_MAX_FILES) throw new AppFileError('too-large', `More than ${FOLDER_DOWNLOAD_MAX_FILES} files in this folder`);
    }
  };
  try {
    await walk(folder, target);
    const total = found.reduce((sum, file) => sum + file.size, 0);
    let done = 0;
    for (const file of found) {
      try {
        await savePieces(page, { workspace: place.workspace, id: file.id }, file.to, { signal, saved: (bytes) => report(done += bytes, total) });
      } catch (error) {
        if (!file.link || signal.aborted) throw error;
        skipped.push(file.id);
      }
    }
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
  return skipped;
}

const downloads = new Map<string, AbortController>();
const downloadKey = (page: DesktopFilePage, transferId: unknown) => `${page.pageId}/${String(transferId)}`;

/** Stops a `files.download` of this page's that is under way. */
export function stopAppFileDownload(page: DesktopFilePage, args: { transferId?: unknown }): void {
  downloads.get(downloadKey(page, args.transferId))?.abort();
}

async function saveTo(source: SaveSource, filePath: string, saving?: Saving): Promise<void> {
  if (source.kind === 'text') return fs.writeFile(filePath, source.text, 'utf8');
  if (source.kind === 'pieces') return savePieces(source.page, source.ref, filePath, saving);
  await writeFileHandle(source.file, filePath);
}

/** A name not yet in `folder`: the file's own, else with 「 (2)」, 「 (3)」… before its suffix (as the folder names a clash). */
async function freePath(folder: string, name: string): Promise<string> {
  const { name: stem, ext } = path.parse(name);
  for (let n = 1; ; n++) {
    const candidate = path.join(folder, n === 1 ? name : `${stem} (${n})${ext}`);
    try { await fs.access(candidate); } catch { return candidate; }
  }
}

/**
 * One file: where to save it, asked (`true` saved). Several (API 20): one folder asked for them all, each saved there under
 * its own name — how many were saved; `0` when the person cancelled.
 */
export async function downloadAppFile(page: DesktopFilePage, args: { ref?: unknown; refs?: unknown; folder?: unknown; transferId?: unknown }, owner: WebContents | null, report?: (transferId: string, done: number, total: number) => void, savedAt?: (filePath: string) => void): Promise<boolean | number | { skipped: string[] }> {
  const window = owner ? BrowserWindow.fromWebContents(owner) : null;
  // A transfer the page follows: what stops it is kept for as long as it runs.
  const transferId = typeof args.transferId === 'string' ? args.transferId : null;
  const stop = new AbortController();
  const told = (done: number, total: number) => { if (transferId) report?.(transferId, done, total); };
  const following = async <T>(run: () => Promise<T>): Promise<T> => {
    const key = downloadKey(page, transferId);
    downloads.set(key, stop);
    try {
      return await run();
    } finally {
      downloads.delete(key);
    }
  };
  if (args.folder === true) {
    const ref = fileRefOf(args.ref);
    if (isChat(ref)) throw new AppFileError('invalid', "Only a working copy's folder is saved whole");
    await mayRead(page, ref, 'saving');
    const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const into = picked.canceled ? null : picked.filePaths[0];
    if (!into) return false;
    const target = await freePath(into, path.posix.basename(pathOfRef(ref)));
    const skipped = await following(() => saveFolder(page, ref as WorkspacePlace, pathOfRef(ref), target, told, stop.signal));
    return skipped.length > 0 ? { skipped } : true;
  }
  if (Array.isArray(args.refs)) {
    if (args.refs.length === 0) throw new AppFileError('invalid', 'files.download(files): give one file or more');
    const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const folder = picked.canceled ? null : picked.filePaths[0];
    if (!folder) return 0;
    let saved = 0;
    for (const ref of args.refs) {
      const source = await downloadSourceOf(page, ref);
      await saveTo(source, await freePath(folder, source.name));
      saved++;
    }
    return saved;
  }
  const source = await downloadSourceOf(page, args.ref);
  const options = { defaultPath: source.name };
  const target = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (target.canceled || !target.filePath) { if (source.kind === 'file') await source.file.dispose(); return false; }
  let done = 0;
  await following(() => saveTo(source, target.filePath as string, { signal: stop.signal, saved: (bytes, size) => told(done += bytes, size) }));
  savedAt?.(target.filePath);
  return true;
}
