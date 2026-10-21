import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BrowserWindow, dialog, type WebContents } from 'electron';
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { configuredEndpoint, fetchAttachmentUrls } from '@gugu/core/cloud/attachmentsApi';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { createAttachmentResolver } from '@gugu/core/shared/attachmentUrls';
import { fetchInChunks } from '@gugu/core/shared/inChunks';
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
  isLocal,
  placeKey,
  placeOf,
  type AppFileEntry,
  type AppFileOpened,
  type AppFileRef,
  type AppFileUpload,
  type AppFileVersion,
  type AppFileVersionContent,
  type LocalFileRef,
  type LocalPlace,
  type ChatPeekFile,
  type PeekTarget,
} from '@shared/extensions/app-runtime-protocol';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { fileServiceUrl, fileSync, localFileService } from '@main/core/extensions/file-sync';
import { createLocalAppFiles, type LocalSurface } from '@main/core/extensions/local-files';
import { readElsewhere } from '@main/core/extensions/app-files-elsewhere';
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
  return { suffix: candidate.suffix, app: { id: candidate.extensionId, name: localizedManifestText(candidate.app, sessionHostLocale()).name, icon: icons.get(key) ?? null } };
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
  pageId: number;
  extensionId: string;
  handed: (AppFileRef & { id: string }) | null;
  asAgent?: string | null;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

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
  async sign(source) {
    const me = await signedIn();
    if (!me) throw new AppFileError('failed', 'Not signed in');
    const link = await createAttachmentResolver((refs) => fetchAttachmentUrls(configuredEndpoint(me.token), refs)).resolve(source);
    return link.status === 'ready' ? link.url : null;
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
export async function localRootOf(place: LocalPlace): Promise<{ workspaceRoot: string; projectId: string; workspaceId: string | null }> {
  if ('project' in place) {
    const { projectRootFolder } = await import('@main/core/projects/operations/project-folders');
    const root = await projectRootFolder(place.project);
    if (!root) throw new AppFileError('not-found', `Project ${place.project} is not a project on this computer`);
    return { workspaceRoot: await fs.realpath(root.path), projectId: place.project, workspaceId: root.workspaceId };
  }
  const { agentSessionContext } = await import('@main/core/extensions/extension-agent-context');
  const session = await agentSessionContext(place.session);
  if (!session?.workspaceRoot) throw new AppFileError('not-found', `Session ${place.session} has no working copy open on this computer`);
  return { workspaceRoot: await fs.realpath(session.workspaceRoot), projectId: session.projectId, workspaceId: session.workspaceId ?? null };
}

async function localFolder(page: DesktopFilePage, place: LocalPlace): Promise<LocalSurface & { projectId: string; workspaceId: string | null }> {
  const handed = page.handed && isLocal(page.handed) && placeKey(page.handed) === placeKey(place) ? page.handed.id : null;
  // Only the keys that say where: a file's ref names its place and itself.
  const where: LocalPlace = 'project' in place ? { project: place.project } : { session: place.session };
  return { pageId: page.pageId, extensionId: page.extensionId, place: where, filePath: handed, ...(await localRootOf(where)) };
}

/**
 * With `files:read:all-machines`, a file of a session that is not on this computer: read whole, on the machine that has
 * it. Null otherwise — the working copy here answers, as it always did.
 */
async function fileElsewhere(page: DesktopFilePage, ref: LocalFileRef) {
  // A project is named by this computer's id for it: another computer's projects are not named here.
  if (!('session' in ref)) return null;
  if (!extensionsService().hasCapability(page.extensionId, 'files:read:all-machines')) return null;
  const { agentSessionContext } = await import('@main/core/extensions/extension-agent-context');
  if (await agentSessionContext(ref.session)) return null;
  const app = { extensionId: page.extensionId, extensionName: extensionsService().get(page.extensionId).manifest.name };
  return readElsewhere(app, ref.session, 'id' in ref ? ref.id : ref.name);
}

const isChat = (ref: AppFileRef): ref is ChatFileRef => !isLocal(ref);
const withId = (ref: AppFileRef, what: string): AppFileRef & { id: string } => {
  if (!('id' in ref)) throw new AppFileError('invalid', `${what} takes a file by its id`);
  return ref;
};

export async function openAppFile(page: DesktopFilePage, args: { ref?: unknown; readOnly?: boolean }): Promise<AppFileOpened> {
  const ref = fileRefOf(args.ref);
  const readOnly = args.readOnly === true ? { readOnly: true } : {};
  const elsewhere = isChat(ref) ? null : await fileElsewhere(page, ref as LocalFileRef);
  // Another machine's file comes as its bytes, read only, whatever it is: no live document across machines.
  if (elsewhere) return { entry: elsewhere.entry, docName: '', access: 'ro', self: await files.self(), bytes: elsewhere.bytes.slice().buffer };
  return isChat(ref)
    ? files.open(chatSurface(page), { ref, ...readOnly })
    : local.open(await localFolder(page, ref), { ref: ref as LocalFileRef, ...readOnly });
}

/** After `stale-epoch:<n>`: the same file at its new epoch. */
export async function reopenAppFile(page: DesktopFilePage, args: { ref?: unknown; readOnly?: boolean }): Promise<AppFileOpened> {
  const ref = withId(fileRefOf(args.ref), 'reopen');
  const readOnly = args.readOnly === true ? { readOnly: true } : {};
  return isChat(ref)
    ? files.reopen(chatSurface(page), { ref: ref as Extract<ChatFileRef, { id: string }>, ...readOnly })
    : local.reopen(await localFolder(page, ref), { ref: ref as LocalFileRef & { id: string }, ...readOnly });
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
  noFoldersInWorkingCopy(folder);
  return local.list(await localFolder(page, place));
}

/** Across every chat whoever the page works as is in (`files:read`, checked at the door): by a piece of the path; opened last. */
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
  if ('chat' in place) return files.create(place.chat, { ...file, sourceMessageIds: args.sourceMessageIds, folder: args.folder }, { asAgent: page.asAgent ?? null });
  noSourceMessagesInWorkingCopy(args.sourceMessageIds);
  noFoldersInWorkingCopy(folderOf(args.folder));
  return local.create(await localFolder(page, place), file);
}

export async function renameAppFile(page: DesktopFilePage, args: { ref?: unknown; name: string }): Promise<AppFileEntry> {
  const ref = fileRefOf(args.ref);
  return isChat(ref)
    ? files.rename(chatSurface(page), { ref, name: args.name })
    : local.rename(await localFolder(page, ref), { ref: ref as LocalFileRef, name: args.name });
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
  return isChat(ref) ? files.remove(chatSurface(page), { ref }) : local.remove(await localFolder(page, ref), { ref: ref as LocalFileRef });
}

/** A file's next content (G1): a chat's stored file becomes its next version; a working copy's file is written over. */
export async function replaceAppFile(page: DesktopFilePage, args: { ref?: unknown; file?: unknown; expectedVersion?: unknown }): Promise<AppFileEntry> {
  const ref = fileRefOf(args.ref);
  const file = args.file as AppFileUpload;
  const expectedVersion = (args.expectedVersion ?? null) as number | null;
  if (isChat(ref)) return files.replace(chatSurface(page), { ref, file, expectedVersion });
  if (expectedVersion !== null) throw new AppFileError('invalid', "A working copy's file has no versions here: replace it without expectedVersion");
  return local.replace(await localFolder(page, ref), { ref: ref as LocalFileRef, file });
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
): Promise<AppFileEntry[]> {
  const where = placeOf(place);
  // A program acting for an agent uploads as that agent (G5): the chat's door judges the agent, the rows are its.
  if ('chat' in where) return files.upload(where.chat, uploads, { asAgent: page.asAgent ?? null, sourceMessageIds, folder });
  noSourceMessagesInWorkingCopy(sourceMessageIds);
  noFoldersInWorkingCopy(folderOf(folder));
  return local.upload(await localFolder(page, where), uploads);
}

export const messageToShow = files.messageToShow;
export const chatMembersOf = files.members;
export const chatsOf = files.chats;
export const surfaceChatOf = files.chat;
export const chatOfItem = files.chatOf;
export const groupFiles = files.groupFiles;
export const groupFile = files.groupFile;

/**
 * Who opens a chat file of this kind: the most specific claim, or the person's 「始终用它」 — what a click opens; with
 * `ask`, every App that opens it, for the person to pick (「用别的 App 打开」, 摩擦单 F2); `none` when nobody here does —
 * the group's panel offers the App that would (161 10-15). One answer for a page's `gugu.files.openWith` and the shell's
 * own ways in (an App card's 「Open」, a file link).
 */
export function openerChoice(typedName: string, ask = false) {
  const service = extensionsService();
  const manifests = service.list().extensions.filter((entry) => service.isEnabled(entry.manifest.id)).map((entry) => entry.manifest);
  const defaults = service.openWithDefaults();
  return chatOpenerChoice(typedName, manifests, 'chat', (key) => defaults[key] ?? null, ask);
}

/**
 * 「用 X 打开」, gated like saving the file: a chat file — who opens it, for the window that shows the chat to open
 * (`AppOpenWithDetail`); a working-copy file — opened in its session's pane by the resolver a click goes through
 * (`openSessionFileForApp`), here and now. Beside the page (`peek`, G1), and always for a project's file (no session's pane
 * holds it): which file in which workspace, for the window to open in the page's own slot.
 */
export async function openWithTarget(
  page: DesktopFilePage,
  args: { ref?: unknown; ask?: boolean; peek?: boolean },
): Promise<
  | { kind: 'chat'; target: { chatId: string; itemId: string; name: string; typedName: string; file: ChatPeekFile } }
  | { kind: 'session' }
  | { kind: 'peek'; target: Extract<PeekTarget, { kind: 'local' }> }
> {
  const ref = fileRefOf(args.ref);
  if (isChat(ref)) return { kind: 'chat', target: await files.openTarget(chatSurface(page), { ref }) };
  const copy = await localFolder(page, ref);
  const found = local.openTarget(copy, { ref: ref as LocalFileRef });
  if (args.peek || !('session' in found.place)) {
    if (!copy.workspaceId) throw new AppFileError('not-found', `${found.name} is in no workspace this computer has open`);
    const { place } = found;
    return { kind: 'peek', target: { kind: 'local', place, projectId: copy.projectId, workspaceId: copy.workspaceId, path: found.path, absolutePath: path.join(copy.workspaceRoot, found.path), name: found.name, ask: args.ask === true } };
  }
  const { openSessionFileForApp } = await import('@main/core/sessions/session-orchestration');
  await openSessionFileForApp({ projectId: copy.projectId, sessionId: found.place.session, path: path.join(copy.workspaceRoot, found.path), ask: args.ask === true });
  return { kind: 'session' };
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
export async function downloadAppFile(page: DesktopFilePage, args: { ref?: unknown }, owner: WebContents | null): Promise<boolean> {
  const ref = fileRefOf(args.ref);
  const elsewhere = isChat(ref) ? null : await fileElsewhere(page, ref as LocalFileRef);
  const source = isChat(ref)
    ? await files.downloadSource(chatSurface(page), { ref })
    : elsewhere
      ? { name: elsewhere.entry.name, bytes: elsewhere.bytes, kind: 'bytes' as const }
      : { ...local.downloadSource(await localFolder(page, ref), { ref: ref as LocalFileRef }), kind: 'bytes' as const };
  const window = owner ? BrowserWindow.fromWebContents(owner) : null;
  const options = { defaultPath: source.name };
  const target = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (target.canceled || !target.filePath) return false;
  if (source.kind === 'text') {
    await fs.writeFile(target.filePath, source.text, 'utf8');
    return true;
  }
  if (source.kind === 'bytes') {
    await fs.writeFile(target.filePath, source.bytes);
    return true;
  }
  const response = await fetch(source.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new AppFileError('failed', `Download failed: HTTP ${response.status}`);
  await fs.writeFile(target.filePath, new Uint8Array(await response.arrayBuffer()));
  return true;
}
