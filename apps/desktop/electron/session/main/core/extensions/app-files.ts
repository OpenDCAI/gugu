import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BrowserWindow, dialog, type WebContents } from 'electron';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { attachmentFileRef } from '@gugu/core/shared/ui/attachmentModels';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { fetchInChunks } from '@gugu/core/shared/inChunks';
import { writeFileHandle } from '@gugu/core/local/files/fileSnapshots';
import {
  AppFileError,
  contentTypeOf,
  createAppFiles,
  sourceMessageIdsOf,
  tooLargeError,
  type ChatFileRef,
  type FileSurface,
} from '@shared/extensions/app-files-core';
import {
  APP_FILE_MAX_BYTES,
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
import { REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import { renderExtensionIcon } from '@main/core/extensions/extension-icon';
import { fileIconKey } from '@shared/extensions/app-icon';
import { claimantOf, openerChoice as chatOpenerChoice } from '@shared/extensions/file-openers';
import { sessionHostLocale } from '@main/core/host-locale';
import { localizedManifestText } from '@shared/extensions/catalog';
import { PACKAGE_MESSAGE_SELECT, type PackageMessageRow, type PackageReads } from '@shared/extensions/attachment-install';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { log } from '@main/lib/logger';

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
  };
}

/**
 * The folder on this computer a call names: a session's working copy, found the one way main finds a session's
 * (`agentSessionContext`, as an App tool call's `_meta` does); a project's root folder, the one its sessions run in
 * (`listProjectFolders`). A session not on this computer or whose working copy is not open, a project not on this
 * computer, is `not-found`. The same files, gates and watch either way: a folder is a folder.
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
  if (!session?.workspaceRoot) throw new AppFileError('not-found', `Session ${target.session} has no working copy open on this computer`);
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

export async function openAppFile(page: DesktopFilePage, args: { ref?: unknown; readOnly?: boolean; deferDetails?: boolean; expectedVersion?: number }): Promise<AppFileOpened> {
  const ref = fileRefOf(args.ref);
  const readOnly = args.readOnly === true ? { readOnly: true } : {};
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
export function closeAppFile(page: DesktopFilePage, args: { docName: string }): void {
  files.close(chatSurface(page), args);
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

/** `f.read(offset, length)`: up to 512 KB of a working copy's file, read on the machine its working copy is on. */
export async function readAppFile(page: DesktopFilePage, args: { ref?: unknown; offset?: unknown; length?: unknown }): Promise<{ size: number; offset: number; data: string }> {
  const ref = fileRefOf(args.ref);
  if (isChat(ref)) throw new AppFileError('invalid', "A chat's file is opened whole: files.open");
  const offset = Number(args.offset) || 0;
  const length = Number(args.length) || 0;
  const there = await onItsMachine(page, ref, 'filesRead', { ref, offset, length });
  if (there.there) return there.value as { size: number; offset: number; data: string };
  const { readWorkingCopy } = await import('./working-copy-files');
  return readWorkingCopy(ref, 'id' in ref ? ref.id : ref.name, offset, length);
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
async function sessionElsewhere(place: WorkspacePlace): Promise<{ sessionId: string; projectId: string | null } | null> {
  const sessionId = workspaceSession(place);
  if (!sessionId) return null;
  const { sessionMachine } = await import('./app-programs-elsewhere');
  const machine = await sessionMachine(sessionId);
  return machine ? { sessionId, projectId: machine.projectId } : null;
}

/**
 * A working copy's file call (`machine: 'place'`) for a session on another of the person's machines: done there, by the
 * same `machineVerbs` that machine's own pages reach. `{ there: false }` for a working copy on this computer.
 */
async function onItsMachine(page: DesktopFilePage, place: WorkspacePlace, method: 'filesList' | 'filesRead', args: Record<string, unknown>) {
  const session = workspaceSession(place);
  if (!session) return { there: false } as const;
  if (!(await elsewhereGated(page, place))) return { there: false } as const;
  const { callOnSessionMachine } = await import('./app-programs-elsewhere');
  const manifest = extensionsService().get(page.extensionId).manifest;
  return callOnSessionMachine({ extensionId: page.extensionId, manifest }, session, method, args, page.asAgent != null);
}

/** Across every chat whoever the page works as is in (`files:read`, checked at the door): by a piece of the path; opened last. */
export async function appFileViewPreferences(_page: DesktopFilePage, args: { place?: unknown; showAppData?: boolean }) {
  const place = placeOf(args.place);
  if (!('chat' in place)) throw new AppFileError('invalid', 'Folder preferences belong to a chat');
  return files.viewPreferences(place.chat, args.showAppData);
}

export async function searchAppFiles(page: DesktopFilePage, args: unknown): Promise<AppFileEntry[]> {
  return files.search(fileSearchOf(args), { asAgent: page.asAgent ?? null });
}

export async function recentAppFiles(page: DesktopFilePage, args: unknown): Promise<AppFileEntry[]> {
  const { limit } = fileSearchOf(args);
  return files.recent(limit === undefined ? {} : { limit }, { asAgent: page.asAgent ?? null });
}

/** 子文件夹 are a chat's: a working copy's files are named by their paths there, folders and all ('' — the top — it has). */
function noFoldersInWorkingCopy(folder: unknown): void {
  if (folder !== undefined && folder !== null && !(typeof folder === 'string' && /^\/*$/.test(folder.trim()))) {
    throw new AppFileError('invalid', "A working copy has no folders here: a file's path there is its name, folders included");
  }
}

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
  noFoldersInWorkingCopy(folderOf(args.folder));
  return local.create(await localFolder(page, place), file);
}

export async function renameAppFile(page: DesktopFilePage, args: { ref?: unknown; name: string }): Promise<AppFileEntry> {
  const ref = fileRefOf(args.ref);
  return isChat(ref)
    ? files.rename(chatSurface(page), { ref, name: args.name })
    : local.rename(await localFolder(page, ref), { ref: ref as WorkspaceFileRef, name: args.name });
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
  if (!('chat' in place)) throw new AppFileError('invalid', "A working copy has no folders here: a file's path there is its name, folders included");
  return files.mkdir(place.chat, { path: args.path }, { asAgent: page.asAgent ?? null });
}

/** 子文件夹: a chat's file or folder into another folder, renamed too when `name` is given. */
export async function moveAppFile(page: DesktopFilePage, args: { ref?: unknown; folder?: unknown; name?: unknown }): Promise<AppFileEntry> {
  const ref = fileRefOf(args.ref);
  if (!isChat(ref)) throw new AppFileError('invalid', "A working copy has no folders here: rename the file to its new path instead");
  return files.move(chatSurface(page), { ref, folder: args.folder, name: args.name });
}

export async function removeAppFile(page: DesktopFilePage, args: { ref?: unknown }): Promise<void> {
  const ref = fileRefOf(args.ref);
  return isChat(ref) ? files.remove(chatSurface(page), { ref }) : local.remove(await localFolder(page, ref), { ref: ref as WorkspaceFileRef });
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
  noFoldersInWorkingCopy(folderOf(folder));
  return local.upload(await localFolder(page, where), uploads);
}

export const messageToShow = files.messageToShow;

/** `files.forward`: a chat's files — a working copy's file is on a computer, in no chat to send it from. */
export async function forwardTargets(page: DesktopFilePage, args: { refs?: unknown }): Promise<AppForwardFilesDetail> {
  if (!Array.isArray(args.refs)) throw new AppFileError('invalid', 'files.forward(files): give one file or more');
  const refs = args.refs.map((given) => {
    const ref = fileRefOf(given);
    if (!isChat(ref)) throw new AppFileError('invalid', "files.forward: only a chat's files are forwarded");
    return ref;
  });
  return files.forwardTargets(chatSurface(page), { refs });
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
  | { kind: 'session'; target: { sessionId: string; path: string; ask: boolean } }
  | { kind: 'peek'; target: Extract<PeekTarget, { kind: 'local' }> }
> {
  const ref = fileRefOf(args.ref);
  if (isChat(ref)) return { kind: 'chat', target: await files.openTarget(chatSurface(page), { ref }) };
  const name = 'id' in ref ? ref.id : ref.name;
  const ask = args.ask === true;
  // A session's working copy on another machine: gated as opening it read-only (the file the page was handed needs nothing).
  const elsewhere = await sessionElsewhere(ref);
  if (elsewhere) {
    const handed = page.handed && isWorkspace(page.handed) && page.handed.workspace === ref.workspace && page.handed.id === name;
    const service = extensionsService();
    if (!handed && !service.hasCapability(page.extensionId, 'files:read') && !service.hasCapability(page.extensionId, 'files:write')) {
      throw new AppFileError('denied', 'Not permitted: opening a file other than the one this page was opened for needs "files:read" or "files:write"');
    }
    return { kind: 'session', target: { sessionId: elsewhere.sessionId, path: name, ask } };
  }
  const copy = await localFolder(page, ref);
  const found = local.openTarget(copy, { ref: ref as WorkspaceFileRef });
  const session = workspaceSession(found.place);
  if (args.peek || !session) {
    if (!copy.workspaceId) throw new AppFileError('not-found', `${found.name} is in no workspace this computer has open`);
    const { place } = found;
    return { kind: 'peek', target: { kind: 'local', place, projectId: copy.projectId, workspaceId: copy.workspaceId, path: found.path, absolutePath: path.join(copy.workspaceRoot, found.path), name: found.name, ask } };
  }
  return { kind: 'session', target: { sessionId: session, path: found.path, ask } };
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
type SaveSource = Awaited<ReturnType<typeof files.downloadSource>> | { name: string; bytes: Uint8Array | Buffer; kind: 'bytes' };

async function downloadSourceOf(page: DesktopFilePage, given: unknown): Promise<SaveSource> {
  const ref = fileRefOf(given);
  if (isChat(ref)) return await files.downloadSource(chatSurface(page), { ref });
  if (await elsewhereGated(page, ref)) {
    // Another machine's file: its pieces, one after another, as `f.blob()` reads it.
    const pieces: Buffer[] = [];
    for (let offset = 0, size = Infinity; offset < size;) {
      const chunk = await readAppFile(page, { ref, offset, length: REMOTE_WORKSPACE_CHUNK_BYTES });
      const bytes = Buffer.from(chunk.data, 'base64');
      size = chunk.size;
      if (bytes.byteLength === 0) break;
      pieces.push(bytes);
      offset += bytes.byteLength;
    }
    return { name: path.posix.basename('id' in ref ? ref.id : ref.name), bytes: Buffer.concat(pieces), kind: 'bytes' as const };
  }
  return { ...local.downloadSource(await localFolder(page, ref), { ref: ref as WorkspaceFileRef }), kind: 'bytes' as const };
}

async function saveTo(source: SaveSource, filePath: string): Promise<void> {
  if (source.kind === 'text') return fs.writeFile(filePath, source.text, 'utf8');
  if (source.kind === 'bytes') return fs.writeFile(filePath, source.bytes);
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
export async function downloadAppFile(page: DesktopFilePage, args: { ref?: unknown; refs?: unknown }, owner: WebContents | null): Promise<boolean | number> {
  const window = owner ? BrowserWindow.fromWebContents(owner) : null;
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
  await saveTo(source, target.filePath);
  return true;
}
