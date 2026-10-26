import { groupFileLink } from '@gugu/core/shared/ui/guguLink';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { clipboard, ipcMain, shell, webContents, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { extensionIdForSession } from '@main/core/extensions/extension-session';
import { extensionBackgroundWebContentsId, runningExtensionBackgrounds } from '@main/core/extensions/extension-background';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { AppModalSessions } from '@shared/extensions/app-modal';
import { extensionPartition, extensionResourceUrl } from '@shared/extensions/partition';
import { onExtensionProgramNotification } from '@main/core/extensions/extension-programs';
import { log } from '@main/lib/logger';
import { events } from '@main/lib/events';
import { extensionProgramNotifiedChannel } from '@shared/extensions/marketEvents';
import { knownSessionMachine, type SessionMachine } from './app-programs-elsewhere';
import {
  bridgeFailure,
  EXTENSION_API_VERSION,
  pageArgument,
  EXTENSION_BRIDGE_CHANNEL,
  EXTENSION_BRIDGE_EVENT_CHANNEL,
  EXTENSION_THEME_CHANNEL,
  type ExtensionBridgeRequest,
  type ExtensionBridgeResponse,
  type ExtensionAppState,
  type ExtensionChat,
  type ExtensionHostContext,
  type ExtensionHostEvent,
  type ExtensionOperator,
  type ExtensionPageFrom,
  type ExtensionSession,
  type ExtensionPaneTab,
  type ExtensionSurfaceMetrics,
  type ExtensionBridgeMethod,
  type MachineVerb,
  isMachineVerb,
  type CheckReadings,
  type PageCounts,
  verbFacts,
  callRefusal,
  CALLER_WORDS,
} from '@shared/extensions/bridge-protocol';
import {
  watchWorkspaceForSurface,
  type WorkspaceWatch,
} from '@main/core/extensions/extension-file-events';
import type {
  ExtensionHostAction,
  ExtensionHostActionOrigin,
} from '@shared/extensions/host-actions';
import { fileSync } from '@main/core/extensions/file-sync';
import { fileRefOf, isLocal, placeKey, placeOf, type AppFileEntry, type AppFileRef, type AppPlace, type LocalPlace } from '@shared/extensions/app-runtime-protocol';
import { placeFor, placeLink, type FileOpenerCandidate } from '@shared/extensions/file-openers';
import type { FilePlace } from '@gugu/core/shared/ui/guguLink';
import { rosterMoved, type MemberChange } from '@shared/extensions/app-files-core';
import { coalescedReads } from '@shared/extensions/coalesced-reads';
import { changedGroupFiles, resourceChatOf, type DesktopFilePage } from '@main/core/extensions/app-files';

/**
 * The host side of the extension bridge.
 *
 * Two rules hold everything else up:
 *
 * 1. **Who is asking comes from the session, never from the payload.** A
 *    surface can put any extension id in its arguments; it cannot run in
 *    another extension's session. So identity is resolved from
 *    `event.sender.session` and the arguments are only ever data.
 * 2. **What it may do is read at call time, not at activation.** The user can
 *    take a capability back while a tab is open, and「撤销某项权限后该扩展继续
 *    可用,只是那件事做不了了」means the next call has to fail — not the next
 *    restart.
 *
 * Refs #2374.
 */

/** What the host knows about one live extension surface. */
interface SurfaceBinding {
  extensionId: string;
  /**
   * The session this surface is drawn in (a session's tab) — `null` for one in none (a chat's panel, the dock). A fact
   * for `getContext().session`, never a target a call falls back on (真源原则 13).
   */
  sessionId: string | null;
  tabId: string;
  /**
   * #6387 Which of the extension's declared tabs this surface draws. A banner a tab
   * posts opens this tab on click — `tabId` alone is a runtime handle and says nothing
   * about which page it is.
   */
  tabName: string;
  /**
   * The working-copy file (relative to its session's, POSIX) this tab was opened for, when it was opened because the
   * extension claimed that file type. Recorded from the bind call, which the HOST makes — the surface never sends it and
   * cannot change it. With `itemId`, the one file it may open without a capability (`ctx.file`).
   */
  filePath: string | null;
  /** G1 With `filePath`: the project whose folder that file is in, for a page opened beside another on a project's file. */
  projectId: string | null;
  /** The chat this surface is drawn for (its panel), when it is: a fact for `getContext().chat`. */
  chatId: string | null;
  /** The chat file the host handed this surface (`ctx.file`). */
  itemId: string | null;
  /**
   * The renderer that embeds this surface — a <webview>'s `hostWebContents`.
   *
   * Recorded rather than looked up globally: host actions have to land on the
   * window that is actually showing this tab, and "the main window" is a guess
   * that goes wrong the moment there is more than one.
   */
  embedderId: number | null;
  /** Who is working this page (`getContext().operator`): the person for every page the host draws; an agent for its `app_check` page. */
  operator: ExtensionOperator;
  metrics: ExtensionSurfaceMetrics;
  modal?: { id: string; data?: unknown };
  /**
   * The theme this page is shown in, when it is not the host's: only a page an agent works (`app_check`'s), which takes
   * its pictures in light and dark (`showAgentPageInTheme`). Null for every surface a person sees — those follow the host.
   */
  themeMode: 'light' | 'dark' | null;
}

const bindings = new Map<number, SurfaceBinding>();
const appModals = new AppModalSessions<SurfaceBinding>(async (modal) => {
  await deliver(modal.binding, { kind: 'closeAppModal', id: modal.id }).catch((reason: unknown) => {
    log.warn('An App modal closed after its window went away', { reason: String(reason) });
  });
});

const observedContents = new WeakSet<WebContents>();

/** Pages and backgrounds share the same document boundary, even before a watch finishes registering. */
function observeDocument(contents: WebContents): void {
  if (observedContents.has(contents)) return;
  observedContents.add(contents);
  contents.on('did-navigate', () => newDocument(contents.id));
  contents.once('destroyed', () => unbindExtensionSurface(contents.id));
}

/**
 * Who calls (真源原则 13: where a page is only fills its context): one of the App's pages, its background page, or its
 * MCP program. The last two sit in no session, no chat and no tab. Every verb takes its target as a parameter, so the
 * three are answered by one `dispatch`; a verb only one of them has says so in its row (`VerbFacts.only`).
 */
export interface BridgeCaller {
  extensionId: string;
  kind: 'page' | 'background' | 'program';
  /** A page's binding; null for the background page and a program. */
  binding: SurfaceBinding | null;
  /** Its id with the file relay: a page's webContents id, a program's own (negative). */
  pageId: number;
  /** As the files code sees this call: which file it may open without a capability (`ctx.file`; a program's, handed). */
  filePage(args: Record<string, unknown>, resource?: boolean): DesktopFilePage;
  /** Where its events go (`filesChanged`). */
  hear(event: ExtensionHostEvent): void;
  /**
   * A program's verb made inside an agent's call to it (the frame names the call): that agent, a bare uuid — null when
   * gugu does not know which — and it works on chats only as that agent (`asCallingAgent`). Absent: in no agent's call.
   */
  callingAgent?: string | null;
}

/** Events to a page or the background page: their webContents, while it lives. */
function hearOn(webContentsId: number): (event: ExtensionHostEvent) => void {
  return (event) => {
    const contents = webContents.fromId(webContentsId);
    if (contents && !contents.isDestroyed()) sendEvent(contents, event);
  };
}

function pageCaller(binding: SurfaceBinding, webContentsId: number): BridgeCaller {
  return {
    extensionId: binding.extensionId,
    kind: 'page',
    binding,
    pageId: webContentsId,
    // Owner 10-14: a chat's files are opened, written and listed as whoever works the page — an agent through its own
    // door (`*_as`: its membership, its name on what it makes, its presence), as a program's call for an agent is.
    filePage: () => ({
      pageId: webContentsId,
      extensionId: binding.extensionId,
      handed: handedFileOf(binding),
      ...(binding.operator.kind === 'agent' ? { asAgent: binding.operator.id.replace(/^user:/, '') } : {}),
    }),
    hear: hearOn(webContentsId),
  };
}

function backgroundCaller(extensionId: string, webContentsId: number): BridgeCaller {
  return {
    extensionId,
    kind: 'background',
    binding: null,
    pageId: webContentsId,
    filePage: () => ({ pageId: webContentsId, extensionId, handed: null }),
    hear: hearOn(webContentsId),
  };
}

/**
 * A page an agent works (owner 10-14; `app_check`'s): its counts (the runtime reports them, 摩擦单 F69), and what reached
 * no one's screen but was handed back to the agent (`VerbFacts.toAgent`).
 */
interface AgentPage {
  counts: PageCounts | null;
  shown: CheckReadings['shown'];
}
const agentPages = new Map<number, AgentPage>();

/** What the check's page did (摩擦单 F69): null when it opened nothing and handed back nothing. */
export function checkReadingsOf(webContentsId: number): CheckReadings | null {
  const page = agentPages.get(webContentsId);
  if (!page || (!page.counts && page.shown.length === 0)) return null;
  const counts = page.counts ?? { writes: 0, writesPerSecond: 0, presenceSets: 0, presencePerSecond: 0, opens: 0, opensSettled: 0 };
  return { ...counts, shown: [...page.shown] };
}

/**
 * One thing handed back to the agent, in words it can follow: the verb and its arguments, shortened — a chat file to save
 * as its link, however the page named it (an entry, its id, its name), found as the agent finds it — the agent reads it
 * with its own tools (owner 10-14). One it cannot open is refused, as the save would be.
 */
async function handToAgent(caller: BridgeCaller, page: AgentPage, verb: string, args: Record<string, unknown>): Promise<void> {
  if (verb === 'filesDownload' && !isLocal(fileRefOf(args.ref))) {
    const files = await import('@main/core/extensions/app-files');
    const found = await files.openWithTarget(caller.filePage(args), { ref: args.ref });
    if (found.kind === 'chat') {
      page.shown.push({ verb, detail: groupFileLink(found.target.itemId) });
      return;
    }
  }
  let detail: string;
  try {
    detail = JSON.stringify(args ?? {});
  } catch {
    detail = String(args);
  }
  page.shown.push({ verb, detail: detail.length > 200 ? `${detail.slice(0, 199)}…` : detail });
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/** Pages whose `gugu.reportError` someone reads back instead of a tab showing it (`app_check`). */
const errorWatchers = new Map<number, (message: string, level: 'error' | 'hint') => void>();

/**
 * What an App's real pages recorded (`gugu.reportError` — errors, and hints for its author like F62's; uncaught errors
 * come through the runtime's own report), wherever the page is: a group's side panel, a task's tab. Kept per App,
 * newest last, each with the page it came from and when (摩擦单 F68: `app_check` reads them — a hint a real page
 * recorded is not "the check passed"). The check's own page is not among them: what it reports goes to the check.
 */
export interface ExtensionErrorRecord {
  at: string;
  message: string;
  /** `hint`: a note for the App's author (摩擦单 F62), not a sign the App is broken. */
  level: 'error' | 'hint';
  page: {
    /** `<extensionId>.<tabName>`; the background page and a program, said as such. */
    tabKind: string;
    chatId: string | null;
    itemId: string | null;
    sessionId: string | null;
    tabId: string;
  };
}
const ERROR_RECORD_MAX = 50;
const errorRecords = new Map<string, ExtensionErrorRecord[]>();

/** The App's recent records from its real pages, newest last (摩擦单 F68, for `app_check`). */
export function recentExtensionErrors(extensionId: string): readonly ExtensionErrorRecord[] {
  return errorRecords.get(extensionId) ?? [];
}

function recordExtensionError(caller: BridgeCaller, message: string, level: 'error' | 'hint' = 'error'): void {
  const { extensionId, binding } = caller;
  const records = errorRecords.get(extensionId) ?? [];
  const page = binding
    ? { tabKind: `${extensionId}.${binding.tabName}`, chatId: binding.chatId, itemId: binding.itemId, sessionId: binding.sessionId, tabId: binding.tabId }
    : { tabKind: `${extensionId} (${caller.kind === 'background' ? 'background page' : 'program'})`, chatId: null, itemId: null, sessionId: null, tabId: '' };
  records.push({ at: new Date().toISOString(), message, level, page });
  if (records.length > ERROR_RECORD_MAX) records.splice(0, records.length - ERROR_RECORD_MAX);
  errorRecords.set(extensionId, records);
  log.warn('Extension reported an error', { extensionId, chatId: binding?.chatId ?? null, message });
}

/**
 * What a page says about itself (title / badge / error) goes to the window that draws it — a task's tab or a group's
 * slot alike; the renderer keeps it by page. A page drawn nowhere (`app_check`'s) has no header: the call succeeds.
 * It lasts as long as the document that said it: see `newDocument`.
 */
function sayAboutPage(binding: SurfaceBinding, action: ExtensionHostAction): Promise<void> {
  return binding.embedderId === null ? Promise.resolve() : deliver(binding, action);
}

/**
 * A reload, or the App moving to another of its pages (`location.href`, a reader back to its shelf), is a new document:
 * what the old one said about itself goes, and the slot starts from the manifest's title — as the old one's open files
 * end there (file-sync.ts). Main hears the commit (`did-navigate`) ahead of the new document's first call.
 */
function newDocument(webContentsId: number): void {
  void appModals.pageGone(webContentsId);
  stopPageWatches(webContentsId);
  const binding = bindings.get(webContentsId);
  if (!binding) return;
  void sayAboutPage(binding, { kind: 'newDocument' }).catch((error: unknown) => {
    log.warn('A page\'s new document was not told to its window', { webContentsId, error: String(error) });
  });
}

/** What a page, the background page or a program reports (`gugu.reportError`, or the host for it) — the one way it goes. */
async function reportFrom(caller: BridgeCaller, message: string, level: 'error' | 'hint'): Promise<void> {
  // A page someone is reading back (`app_check`) has no tab to show it on: it goes to them.
  const watcher = errorWatchers.get(caller.pageId);
  if (watcher) {
    watcher(message, level);
    return;
  }
  // Any context may report (摩擦单 F13), and every real page's report is kept in the App's record (F68) — the
  // agent's check reads it. A hint (F62) is for the App's author: neither a slot nor a tab says the App is broken.
  recordExtensionError(caller, message, level);
  // Its tab or slot says the App has an error (摩擦单 F63), without stopping anyone.
  if (level === 'error' && caller.binding) await sayAboutPage(caller.binding, { kind: 'reportError', message });
}

/**
 * An App page tried to go somewhere else (统筹 06:52, as L9 does on the phone): it stays where it is — `will-navigate`
 * keeps it on its own `gugu-ext://<id>` — and now its author hears why, as an error the page reported itself: the App's
 * record, its slot's red dot, `app_check`. A link out opens with `gugu.openBrowserTab`.
 */
export function reportBlockedNavigation(webContentsId: number, url: string): void {
  const binding = bindings.get(webContentsId);
  if (!binding) return;
  let where = url;
  try {
    where = new URL(url).origin;
  } catch {
    // Not a URL at all: said as it was written.
  }
  const message = `This page stays on its own origin: going to ${where} was stopped. Open links with gugu.openBrowserTab(url).`;
  void reportFrom(pageCaller(binding, webContentsId), message, 'error').catch(() => undefined);
}

/** `app_check`: hear what this page reports with `gugu.reportError`, until the returned stop. */
export function watchExtensionSurfaceErrors(webContentsId: number, onError: (message: string, level: 'error' | 'hint') => void): () => void {
  errorWatchers.set(webContentsId, onError);
  return () => {
    if (errorWatchers.get(webContentsId) === onError) errorWatchers.delete(webContentsId);
  };
}

/**
 * Where each caller asked to hear that files changed (`files.onChanged(place, fn)`, `filesWatch`) — a page, the
 * background page, a program — by subscription: a chat (told by `notifyGroupWorkspaceChanged`) or a session's working copy
 * (its own disk watch). Torn down with the caller.
 */
const pageWatches = new Map<number, Map<string, { caller: BridgeCaller; place: AppPlace; resource: AppPlace; disk: WorkspaceWatch | null }>>();

/** The map itself is the document's identity; navigation removes it before a later document can subscribe. */
function fileWatchesFor(pageId: number) {
  let watching = pageWatches.get(pageId);
  if (!watching) pageWatches.set(pageId, watching = new Map());
  return watching;
}

/** Each page's forum subscriptions (`gugu.forum.onChanged`), by post id or 'feed': torn down with the page's other watches. */
const forumWatches = new Map<number, Map<string, () => void>>();

async function watchForum(caller: BridgeCaller, target: unknown, on: boolean): Promise<void> {
  const key = typeof target === 'string' ? target : '';
  let mine = forumWatches.get(caller.pageId);
  if (!on) {
    mine?.get(key)?.();
    mine?.delete(key);
    return;
  }
  if (mine?.has(key)) return;
  const { forumForApp } = await import('@main/core/extensions/extension-send');
  const stop = forumForApp.watch(target, (change) => caller.hear({ type: 'forumChanged', target: key, change }));
  if (!mine) {
    mine = new Map();
    forumWatches.set(caller.pageId, mine);
  }
  mine.set(key, stop);
}

export function stopPageWatches(pageId: number): void {
  for (const stop of forumWatches.get(pageId)?.values() ?? []) stop();
  forumWatches.delete(pageId);
  const watching = pageWatches.get(pageId);
  for (const watch of watching?.values() ?? []) watch.disk?.stop();
  pageWatches.delete(pageId);
  for (const { resource, caller } of watching?.values() ?? []) forgetUnheard(resource, caller);
}

/** Start (or stop) telling a caller that files changed in one place. Rides on `files:read`, re-read at every batch. */
async function watchFiles(caller: BridgeCaller, watchId: string, place: AppPlace, on: boolean): Promise<void> {
  let watching = pageWatches.get(caller.pageId);
  const existing = watching?.get(watchId);
  if (!on) {
    existing?.disk?.stop();
    watching?.delete(watchId);
    if (existing) forgetUnheard(existing.resource, existing.caller);
    return;
  }
  watching = fileWatchesFor(caller.pageId);
  const resource = 'chat' in place ? { chat: await resourceChatOf(place.chat, { asAgent: caller.callingAgent ?? caller.filePage({ place }, true).asAgent ?? null }) } : place;
  if (pageWatches.get(caller.pageId) !== watching) return;
  asCallingAgent(caller, caller.filePage({ place: resource }, true), { place });
  if (watching.has(watchId)) throw Object.assign(new Error('This file watch is already registered'), { code: 'invalid' });
  let disk: WorkspaceWatch | null = null;
  if (isLocal(place)) {
    const { localRootOf } = await import('@main/core/extensions/app-files');
    const { workspaceRoot } = await localRootOf(place);
    if (pageWatches.get(caller.pageId) !== watching) return;
    disk = watchWorkspaceForSurface({
      extensionId: caller.extensionId,
      workspaceRoot,
      deliver: (change) => caller.hear({ type: 'filesChanged', watchId, place, change }),
    });
  }
  watching.set(watchId, { caller, place, resource, disk });
}

/**
 * Ties a live surface to the task it is showing.
 *
 * The renderer supplies the task and its working copy because it is the side
 * that knows which task a tab belongs to; it is host code, and the extension
 * cannot reach this call. What main does *not* take on trust is the extension
 * identity: that is re-derived from the webContents' own session, so a wrong or
 * malicious binding cannot hand one extension another's surface.
 */

/**
 * The file a claimed tab was opened for, in the shape the protocol promises:
 * relative to its session's working copy, POSIX separators — the id `gugu.files` gives it and
 * `filesChanged` reports.
 *
 * Normalised HERE rather than at each caller: the file browser hands over an
 * absolute machine path, `openSessionFile` hands over a resolved one, and a surface
 * that had to tell them apart would be doing the host's job. Measured on the real
 * app — the extension received `/Users/…/probe.sql` while the protocol said
 * relative, which is a contract the host broke, not the extension.
 *
 * Outside the working copy is dropped rather than passed through: the surface
 * consented to this working copy, and a path it cannot place is worse than none.
 */
async function workspaceRelativeFile(place: LocalPlace | null, filePath?: string): Promise<string | null> {
  if (!filePath) return null;
  if (!path.isAbsolute(filePath)) return filePath.split(path.sep).join('/');
  if (!place) return null;
  const { localRootOf } = await import('@main/core/extensions/app-files');
  const root = await localRootOf(place).then((found) => found.workspaceRoot, () => null);
  if (!root) return null;
  const relative = path.relative(root, fs.realpathSync(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * 谁在等自己的绑定落地。
 *
 * 为什么需要这东西:绑定发生在 `dom-ready`,而那是 guest **把脚本跑完之后**才到的时刻
 * —— webview 的 `getWebContentsId()` 在此之前会抛「must be attached … and the dom-ready
 * event emitted」,所以宿主没有更早的机会去绑(实测证伪过「不给 src、绑完再 loadURL」那条
 * 路:那样 guest 永不导航,也就永不 dom-ready,面永远空白)。
 *
 * 于是扩展在启动时调的每一个动词,都在跟这次 IPC 赛跑。输了就被下面那句「还没绑定」拒掉,
 * 而没有人会重试 —— 那一栏就永远停在错误上。owner 换个会话就撞到:SQL 那栏显示「读不到
 * 工作副本」,文件一个没有;第一个会话看着正常,只是恰好赢了。
 *
 * ❌ 不是「重试兜底」:这个时序是宿主自己造的(它决定了先导航后绑定),所以由宿主来吸收。
 * 等待有上限,等不到照旧响亮失败 —— 只是不再把一次「还没轮到」当成「不许」。
 */
const bindingWaiters = new Map<number, (() => void)[]>();
const BINDING_WAIT_MS = 5000;

function resolveBindingWaiters(webContentsId: number): void {
  const waiters = bindingWaiters.get(webContentsId);
  if (!waiters) return;
  bindingWaiters.delete(webContentsId);
  for (const wake of waiters) wake();
}

function waitForBinding(webContentsId: number): Promise<void> {
  return new Promise((resolve) => {
    const waiters = bindingWaiters.get(webContentsId) ?? [];
    let done = false;
    const wake = () => {
      if (done) return;
      done = true;
      resolve();
    };
    waiters.push(wake);
    bindingWaiters.set(webContentsId, waiters);
    setTimeout(wake, BINDING_WAIT_MS);
  });
}

export async function bindExtensionSurface(input: {
  webContentsId: number;
  extensionId: string;
  /** Absent for a surface that is not in a session (a chat's side panel, the dock). */
  sessionId?: string;
  tabId: string;
  tabKind: string;
  /** Set only when the tab was opened for a file of its session this extension claimed. */
  filePath?: string;
  /** G1 A page opened beside another for a file of a project's folder (`filePath` in it): no session holds it. */
  projectId?: string;
  chatId?: string;
  itemId?: string;
  /** Who works it: the person unless main binds it for an agent (`app_check`); never the renderer's to say. */
  operator?: ExtensionOperator;
  modal?: { id: string; data?: unknown };
}): Promise<void> {
  const contents = webContents.fromId(input.webContentsId);
  if (!contents) throw new Error(`No such webContents: ${input.webContentsId}`);
  const sessionExtensionId = extensionIdForSession(contents.session);
  if (!sessionExtensionId) {
    throw new Error('That surface is not running in an App session');
  }
  if (sessionExtensionId !== input.extensionId) {
    // The binding claims one extension while the surface runs as another. Not a
    // recoverable mismatch: honouring either side would let a tab of extension A
    // be answered with extension B's grants.
    throw new Error(
      `Surface belongs to "${sessionExtensionId}", not "${input.extensionId}"`
    );
  }
  // 按这个 session 的扩展 id 当前缀拆,❌ 不信调用方说自己是哪个扩展的 tab。
  const kindPrefix = `${sessionExtensionId}.`;
  const tabName = input.tabKind.startsWith(kindPrefix) ? input.tabKind.slice(kindPrefix.length) : '';
  if (!tabName) {
    throw new Error(`Tab kind "${input.tabKind}" does not belong to "${sessionExtensionId}"`);
  }
  const projectId = input.filePath && !input.sessionId ? (input.projectId ?? null) : null;
  const filePath = await workspaceRelativeFile(input.sessionId ? { session: input.sessionId } : projectId ? { project: projectId } : null, input.filePath);
  // Bound again for another group or file (the host normally retargets instead): the open files the
  // page holds were granted under the old binding, so they go, as in `retargetExtensionSurface`.
  const chatId = input.chatId ? await resourceChatOf(input.chatId, { asAgent: input.operator?.kind === 'agent' ? input.operator.id.replace(/^user:/, '') : null }) : null;
  const previous = bindings.get(input.webContentsId);
  if (previous && (previous.chatId !== chatId || previous.itemId !== (input.itemId ?? null))) {
    fileSync.revoke(input.webContentsId, 'unbound');
  }
  bindings.set(input.webContentsId, {
    extensionId: sessionExtensionId,
    sessionId: input.sessionId ?? null,
    tabId: input.tabId,
    tabName,
    filePath,
    projectId,
    chatId,
    itemId: input.itemId ?? null,
    embedderId: contents.hostWebContents?.id ?? null,
    operator: input.operator ?? { kind: 'person' },
    ...(input.modal ? { modal: input.modal } : {}),
    // Zero until the pane reports its box. Stated rather than guessed: a made-up
    // size would be indistinguishable from a measured one.
    metrics: { visible: true, width: 0, height: 0 },
    themeMode: null,
  });
  if (input.operator?.kind === 'agent') agentPages.set(input.webContentsId, { counts: null, shown: [] });
  // Which machine its session is on, found once now: whose program's notifications it hears is read from that
  // (`knownSessionMachine`), never asked of every machine per notification.
  const sessionId = input.sessionId;
  if (sessionId) {
    void import('./app-programs-elsewhere').then(({ sessionMachine }) => sessionMachine(sessionId)).catch((error: unknown) => {
      log.warn('[extensions] a page\'s session was found on no machine; it hears no machine\'s program', { sessionId, error: error instanceof Error ? error.message : String(error) });
    });
  }
  observeDocument(contents);
  // 在这条线上等着的那些调用,现在可以往下走了。
  resolveBindingWaiters(input.webContentsId);
  flushQueuedSurfaceEvents(input.webContentsId, bindings.get(input.webContentsId)!);
}

/**
 * Where a page is, as a click names it: a session, a chat, or `own` — the App's own page, in neither (真源原则 13).
 * What a link or a banner click opened is told there.
 */
export type OpenedPlace = AppPlace | 'own';
const whereKey = (opened: OpenedPlace) => (opened === 'own' ? 'own' : placeKey(opened));
function whereOf(binding: SurfaceBinding): string {
  if (binding.sessionId) return placeKey({ session: binding.sessionId });
  return binding.chatId ? placeKey({ chat: binding.chatId }) : 'own';
}

/**
 * #6387 Events meant for a page that is still opening — a link or a banner click just
 * asked for it. Held until a page of that extension binds there, then handed
 * over once; the preload keeps them until the page subscribes, so a slow page misses
 * nothing. Bounded in time: a page that never came is not a debt to pay much later.
 */
interface QueuedSurfaceEvent {
  extensionId: string;
  where: string;
  /**
   * App 引用 pill: the file the event is for (a pill's place) — only a page bound to that file takes it: a chat file's id,
   * or a working-copy file's path (`fileOf`). Null: any page there.
   */
  item: string | null;
  event: ExtensionHostEvent;
  expiresAt: number;
}
const queuedSurfaceEvents: QueuedSurfaceEvent[] = [];
/** The file a page was opened for: a chat file's id, or a working-copy file's path. */
const fileOf = (binding: SurfaceBinding) => binding.itemId ?? binding.filePath;
const QUEUED_SURFACE_EVENT_TTL_MS = 30_000;

/**
 * What waits for this page, handed over in the order it came — the page keeps the last (复核 71c15165 要改 1: newest first
 * put an older pill's place over the one the person clicked last). A pill's place goes only to a page of its file;
 * `itemsOnly`: the page was moved to another file (`retargetExtensionSurface`), not opened — what waits for any page is
 * not its.
 */
function flushQueuedSurfaceEvents(webContentsId: number, binding: SurfaceBinding, itemsOnly = false): void {
  const now = Date.now();
  const where = whereOf(binding);
  const due: ExtensionHostEvent[] = [];
  for (let i = 0; i < queuedSurfaceEvents.length; ) {
    const queued = queuedSurfaceEvents[i]!;
    const mine = queued.extensionId === binding.extensionId && queued.where === where
      && (queued.event.type !== 'link' || queued.event.tab === binding.tabName)
      && (queued.item === null ? !itemsOnly && (queued.event.type !== 'link' || queued.event.file !== null || fileOf(binding) === null) : queued.item === fileOf(binding));
    if (queued.expiresAt < now || mine) {
      queuedSurfaceEvents.splice(i, 1);
      if (queued.expiresAt >= now) due.push(queued.event);
    } else {
      i += 1;
    }
  }
  const contents = webContents.fromId(webContentsId);
  if (contents && !contents.isDestroyed()) for (const event of due) sendEvent(contents, event);
}

/**
 * #6387 Hand an event to one extension: its background page, and its pages where a click opened it (`opened`; null:
 * the background page alone).
 *
 * A page of that extension already open there gets it now; otherwise it waits for
 * the page being opened (see `queuedSurfaceEvents`). Returns what was reached, so the
 * caller can say so instead of assuming.
 */
export function deliverToExtension(
  extensionId: string,
  event: ExtensionHostEvent,
  opened: OpenedPlace | null,
): { background: boolean; views: number } {
  let background = false;
  const backgroundId = extensionBackgroundWebContentsId(extensionId);
  const backgroundContents = backgroundId === null ? null : webContents.fromId(backgroundId);
  if (backgroundContents && !backgroundContents.isDestroyed()) {
    sendEvent(backgroundContents, event);
    background = true;
  }
  let views = 0;
  if (opened) {
    const where = whereKey(opened);
    for (const [webContentsId, binding] of bindings) {
      if (binding.extensionId !== extensionId || whereOf(binding) !== where) continue;
      if (event.type === 'link' && (event.tab !== binding.tabName || (event.file === null && fileOf(binding) !== null))) continue;
      const contents = webContents.fromId(webContentsId);
      if (!contents || contents.isDestroyed()) continue;
      sendEvent(contents, event);
      views += 1;
    }
    if (views === 0) {
      queuedSurfaceEvents.push({
        extensionId,
        where,
        item: null,
        event,
        expiresAt: Date.now() + QUEUED_SURFACE_EVENT_TTL_MS,
      });
    }
  }
  return { background, views };
}

/**
 * App 引用 pill (148 17:21): the place a pill points at, for the page about to open that file (`item`) — never one bound
 * there now (each open is a page of its own, 摩擦单 F28: an older one there is on its way out), nor a page of another file
 * of that chat (复核 71c15165 要改 1). Held as a page still opening holds a gugu link's `link` event, handed over when a
 * page of that file binds there (or is moved to it).
 */
export function deliverToOpeningPage(extensionId: string, event: ExtensionHostEvent, opened: AppPlace, item: string): void {
  queuedSurfaceEvents.push({ extensionId, where: whereKey(opened), item, event, expiresAt: Date.now() + QUEUED_SURFACE_EVENT_TTL_MS });
}

/**
 * The place a link in a session's chat names in one of its working copy's files (`path#k=v&…`), for the App tab that opens
 * it — as a chat file's pill tells its page (`deliverToOpeningPage`). A session shows a file in one tab: one already open
 * on it is told now; else the page about to open it, or be moved to it, when it binds there.
 */
export async function deliverToSessionFilePage(candidate: Pick<FileOpenerCandidate, 'extensionId' | 'tabKind'>, at: FilePlace, sessionId: string, filePath: string): Promise<void> {
  const file = await workspaceRelativeFile({ session: sessionId }, filePath);
  if (!file) throw new Error(`${filePath} is not in this session's working copy`);
  const event = placeLink(candidate, at, file);
  const open = [...bindings].filter(([, binding]) => binding.extensionId === candidate.extensionId && binding.sessionId === sessionId && binding.filePath === file);
  for (const [webContentsId] of open) {
    const contents = webContents.fromId(webContentsId);
    if (contents && !contents.isDestroyed()) sendEvent(contents, event);
  }
  if (open.length === 0) deliverToOpeningPage(candidate.extensionId, event, { session: sessionId }, file);
}

/**
 * The session the person is looking at, or last looked at — what idle reclaim keeps (`install-idle-reclaim.ts`). No App
 * verb opens into it: a link or a banner names where it opens (真源原则 13). Null until the renderer has reported a
 * session view at least once.
 */
export function currentOrLastSession(): { sessionId: string; projectId: string } | null {
  if (appView.activeSessionId && appView.activeProjectId) {
    return { sessionId: appView.activeSessionId, projectId: appView.activeProjectId };
  }
  return lastSessionView;
}

/**
 * 同一张页换到另一条会话页上去显示 —— 扩展一律 app 级,一个扩展整个 app 只有一张页,
 * 切会话时宿主把它挪到新会话那一格的位置上,而不是重建(behavior tab-extensions:
 * 「切会话那一格纹丝不动」)。这里换的是它「现在是给谁看的」:任务、tab、工作副本、项目、会话。
 *
 * ❌ 不走「再 bind 一次」:bindSurface 每次都会挂一个 `once('destroyed')`,重复调用就会堆监听器。
 * 页面自己订的文件监听(`files.onChanged(place)`)说的是它点名的地方,和这一格在哪无关,留着。
 * 尺寸留着:新的一格换完会再报一次,一样大就什么都不推,不一样大才再推一次(摩擦单 F115:原来清零,每换一次都推两遍)。
 */
export async function retargetExtensionSurface(input: {
  webContentsId: number;
  sessionId?: string;
  tabId: string;
  filePath?: string;
  chatId?: string;
  itemId?: string;
}): Promise<void> {
  const binding = bindings.get(input.webContentsId);
  if (!binding) throw new Error('That surface is not bound yet');
  const contents = webContents.fromId(input.webContentsId);
  if (!contents || contents.isDestroyed()) throw new Error(`No such webContents: ${input.webContentsId}`);
  const sessionId = input.sessionId ?? null;
  const filePath = await workspaceRelativeFile(sessionId ? { session: sessionId } : null, input.filePath);
  // Another handed-over file: the one it could open without a capability was the old one, so its open files go (it is
  // told, and reopens what it may). Its other files were never the place's to give.
  if (sessionId !== binding.sessionId || filePath !== binding.filePath || (input.itemId ?? null) !== binding.itemId) {
    fileSync.revoke(input.webContentsId, 'unbound');
  }
  const was = fileOf(binding);
  binding.sessionId = sessionId;
  binding.tabId = input.tabId;
  binding.filePath = filePath;
  binding.projectId = null;
  binding.chatId = input.chatId ? await resourceChatOf(input.chatId, { asAgent: binding.operator.kind === 'agent' ? binding.operator.id.replace(/^user:/, '') : null }) : null;
  binding.itemId = input.itemId ?? null;
  pushContext(input.webContentsId);
  // Moved to a file a pill or a link is waiting to open: its place is this page's now.
  if (fileOf(binding) !== null && fileOf(binding) !== was) flushQueuedSurfaceEvents(input.webContentsId, binding, true);
}

export function unbindExtensionSurface(webContentsId: number): void {
  void appModals.pageGone(webContentsId);
  bindings.delete(webContentsId);
  agentPages.delete(webContentsId);
  // Its open files rested on the binding — but only a page that lives on (uninstall, disable) loses
  // them here. A page that is gone is the relay's to finish: it writes out what the page handed
  // over and keeps its will. Revoking here first would throw the will away (measured: an offline
  // change of a closed page never reached the open file).
  const contents = webContents.fromId(webContentsId);
  if (contents && !contents.isDestroyed()) fileSync.revoke(webContentsId, 'unbound');
  // Stopped with the binding, not left to a GC that never comes: a watch outlives
  // its surface as a live subscription on a held runtime lease, and the events it
  // keeps delivering land on a webContents that is gone.
  stopPageWatches(webContentsId);
  // 面没了,还在等它绑定的调用就别再等满那 5 秒了 —— 醒来发现没有绑定,照旧被拒。
  resolveBindingWaiters(webContentsId);
}

/**
 * Uninstall drops every surface of that extension here, while its tabs are still open: they fall
 * back to the placeholder in the renderer, and main must not keep a binding (or a watch) whose
 * next callback asks the service about an id it no longer has.
 */
export function unbindExtensionSurfaces(extensionId: string): void {
  for (const [webContentsId, binding] of bindings) {
    if (binding.extensionId === extensionId) unbindExtensionSurface(webContentsId);
  }
}

/** A chat's files a revision named, or `'all'` of them. */
export type GroupFilesChange = { chatId: string; itemIds: readonly string[] | 'all' };

/**
 * An agent's call to the App's program works on chats — their files and messages — only as that agent (170 10-19): what the
 * call handed (`gugu-file`, `gugu-chat`) and the chat of a file it handed; anything else is refused, never done as the person
 * who installed the App. Outside a call, and a person's page calling the program: as the person, by the capability words. A
 * folder on this computer (a session's working copy, a project's folder) is no chat's: it stays the capability's (170 10-19)
 * — there is no membership to check a folder against, and an agent here reads this computer's disk with its own tools, so
 * holding it to what it handed would stop nothing. The chat rule keeps an App from reaching past what the account may see.
 */
function asCallingAgent(caller: BridgeCaller, page: DesktopFilePage, args: Record<string, unknown>): DesktopFilePage {
  const local = [args.ref, args.place].some((named) => named !== null && typeof named === 'object' && isLocal(named));
  if (caller.callingAgent === undefined || page.asAgent || local) return page;
  throw Object.assign(new Error('An agent\'s call works as that agent: hand it the file (a "gugu-file" parameter) or its chat ("gugu-chat")'), { code: 'denied' });
}

/** File scope compares resource containers; message scope still compares the handed discussion addresses. */
async function resourcePage(caller: BridgeCaller, args: Record<string, unknown>): Promise<DesktopFilePage> {
  const ref = args.ref === undefined ? null : fileRefOf(args.ref);
  const place = args.place === undefined ? null : placeOf(args.place);
  const named = ref ?? place;
  if (!named || !('chat' in named) || named.chat === undefined) return caller.filePage(args, true);
  const actor = caller.callingAgent ?? caller.filePage(args, true).asAgent ?? null;
  const chat = await resourceChatOf(named.chat, { asAgent: actor });
  return caller.filePage(ref ? { ...args, ref: { ...ref, chat } } : { ...args, place: { chat } }, true);
}

/** Who reads a chat's files for a caller: the person, or the agent its page works as (`*_as`). */
const readerOf = (caller: BridgeCaller, chatId: string): string | null => caller.filePage({ place: { chat: chatId } }, true).asAgent ?? null;
const hearsFiles = (caller: BridgeCaller, chatId: string) => extensionsService().hasCapability(caller.extensionId, 'files:read')
  && (caller.callingAgent === undefined || readerOf(caller, chatId) !== null);
const readKey = (chatId: string, reader: string | null) => `${chatId}:${reader ?? 'person'}`;

/** A chat no caller hears as `caller`'s reader any more (it stopped, or its page went): what was kept for it goes. */
function forgetUnheard(place: AppPlace, caller: BridgeCaller): void {
  if (!('chat' in place)) return;
  const reader = readerOf(caller, place.chat);
  for (const places of pageWatches.values()) for (const watch of places.values()) {
    if (placeKey(watch.resource) === placeKey(place) && hearsFiles(watch.caller, place.chat) && readerOf(watch.caller, place.chat) === reader) return;
  }
  groupReads.forget(readKey(place.chat, reader));
}

/** One read at a time per chat and reader; a failed one's ids go with the next (`coalescedReads`). */
const groupReads = coalescedReads((key, error) =>
  log.error(`Reading the files a revision named (${key}) failed twice; they go with its next read:`, error),
);

/**
 * A chat's files changed (#7257): the account's revisions say which (`workspace_changed` names the file). Every caller
 * that asked to hear about that chat (`files.onChanged({ chat }, fn)`) hears those files as it reads them — `{ kind:
 * 'entries', entries, gone }`, `gone` the ids no longer there for it — on a working copy's gate (`files:read`). Read once
 * per chat and reader (`coalescedReads`: ids named while a read is out go in one more). Settles when those reads are done.
 */
export function notifyGroupWorkspaceChanged(changes: readonly GroupFilesChange[]): Promise<void> {
  const reads: Promise<void>[] = [];
  for (const { chatId, itemIds } of changes) {
    const key = placeKey({ chat: chatId });
    const readers = new Set<string | null>();
    for (const places of pageWatches.values()) for (const watch of places.values()) {
      if (placeKey(watch.resource) === key && hearsFiles(watch.caller, chatId)) readers.add(readerOf(watch.caller, chatId));
    }
    for (const reader of readers) {
      reads.push(groupReads.want(readKey(chatId, reader), itemIds, async (wanted) => {
        const change = await changedGroupFiles(chatId, reader, wanted);
        if (change.entries.length > 0 || change.gone.length > 0) tellGroupFiles(chatId, reader, change);
      }));
    }
  }
  return Promise.all(reads).then(() => undefined);
}

function tellGroupFiles(chatId: string, reader: string | null, change: { entries: AppFileEntry[]; gone: string[] }): void {
  const key = placeKey({ chat: chatId });
  for (const places of pageWatches.values()) for (const [watchId, watched] of places) {
    if (placeKey(watched.resource) !== key || !hearsFiles(watched.caller, chatId) || readerOf(watched.caller, chatId) !== reader) continue;
    watched.caller.hear({ type: 'filesChanged', watchId, place: watched.place, change: { kind: 'entries', ...change } });
  }
}

const installedAppsListeners = new Set<() => void>();

/**
 * #7317 Main hears the same change: an App can be the switch of something this computer does (Computer Use ↔ its
 * computer control), which must follow the App at once, ❌ at the next heartbeat.
 */
export function onInstalledAppsChanged(listener: () => void): () => void {
  installedAppsListeners.add(listener);
  return () => installedAppsListeners.delete(listener);
}

/**
 * 摩擦单 F87: the Apps installed here changed — installed, upgraded, uninstalled, switched on or off — and with them who
 * opens which group file (`claimedBy`, the name a list shows). Every open group page hears every file of its chat again,
 * so a list shows the new claims at once, not at the next change of a file (S24: ~2 min of a raw name and a generic icon).
 */
export function notifyInstalledAppsChanged(): Promise<void> {
  for (const listener of [...installedAppsListeners]) {
    try {
      listener();
    } catch (error) {
      log.warn('extensions: a listener of the installed Apps failed', { error: String(error) });
    }
  }
  const chats = new Set<string>();
  for (const places of pageWatches.values()) for (const { resource } of places.values()) if ('chat' in resource) chats.add(resource.chat);
  return notifyGroupWorkspaceChanged([...chats].map((chatId) => ({ chatId, itemIds: 'all' as const })));
}

/** Host-side facts that change while a surface is open. */
export function updateExtensionSurfaceLayout(
  webContentsId: number,
  metrics: ExtensionSurfaceMetrics
): void {
  const binding = bindings.get(webContentsId);
  if (!binding) return;
  const unchanged =
    binding.metrics.visible === metrics.visible &&
    binding.metrics.width === metrics.width &&
    binding.metrics.height === metrics.height;
  // A resize drag fires continuously; re-pushing an identical context would turn
  // one drag into a stream of events every surface has to ignore.
  if (unchanged) return;
  binding.metrics = metrics;
  pushContext(webContentsId);
}

/**
 * Host callbacks the bridge needs but must not implement itself.
 *
 * Renaming a tab, badging it, opening a browser tab and delivering a message
 * are all things the **host** does; the bridge only decides whether the ask is
 * allowed. Keeping them injected is what stops this module from reaching into
 * the tab store and the conversation store, and is why it stays unit-testable
 * without Electron.
 */
export interface ExtensionBridgeHost {
  /**
   * Hands one allowed action to whoever draws it. Throws if it cannot be
   * delivered — a surface that asked for something and got silence would have
   * no way to tell "done" from "went nowhere".
   */
  deliver(
    origin: ExtensionHostActionOrigin & { embedderId: number | null },
    action: ExtensionHostAction
  ): Promise<void>;
  /**
   * Host-side facts main cannot compute on its own (language, theme) plus the
   * window state it can (fullscreen), read together so one call answers「用户此刻
   * 看到的是什么样子」.
   */
  presentation(): {
    locale: string;
    themeMode: 'light' | 'dark';
    fullscreen: boolean;
    /**
     * Whether gugu's window is in the foreground.
     *
     * Sits with `fullscreen`, not with the renderer's report, for the reason
     * `ExtensionSurfaceMetrics` already states: it is a window fact main reads
     * directly, and a second reporter would mean one truth with two sources.
     */
    windowFocused: boolean;
  };
}

let host: ExtensionBridgeHost | null = null;

export function setExtensionBridgeHost(next: ExtensionBridgeHost | null): void {
  host = next;
}

function requireHost(): ExtensionBridgeHost {
  if (!host) throw new Error('App bridge host is not installed');
  return host;
}

/** Sends one action to the renderer that draws this surface: a tab of a task, or a slot in no task (`sessionId` null). */
function deliver(binding: SurfaceBinding, action: ExtensionHostAction): Promise<void> {
  return requireHost().deliver(
    {
      extensionId: binding.extensionId,
      sessionId: binding.sessionId,
      tabId: binding.tabId,
      embedderId: binding.embedderId,
    },
    action
  );
}

/**
 * A session brought up the way a click on its row in the task list brings it, from any page of gugu — the way an agent's
 * banner brings its session up (notificationFocusSessionChannel): `showSession`, and a session's `compose`.
 */
async function bringSessionUp(session: { sessionId: string; projectId: string }): Promise<void> {
  const [{ events }, { notificationFocusSessionChannel }] = await Promise.all([import('@main/lib/events'), import('@shared/events/appEvents')]);
  events.emit(notificationFocusSessionChannel, session);
}

/**
 * Each chat a surface sits in: the group, topic or private chat itself (`getContext().chat`: name, kind, its group) and who is in it
 * (摩擦单 F36), read together when a page of that chat first asks for its context, and again when who is in it changes
 * (the window says so, `chatMembersChanged`); every page of the chat is then told (`onContextChanged`).
 */
const chatsDrawnIn = new Map<string, { chat: ExtensionChat | null; members: NonNullable<ExtensionHostContext['chat']>['members'] }>();

async function readChatMembers(chatId: string): Promise<void> {
  if (![...bindings.values()].some((binding) => binding.chatId === chatId)) {
    chatsDrawnIn.delete(chatId);
    return;
  }
  const files = await import('@main/core/extensions/app-files');
  const [members, chat] = await Promise.all([files.chatMembersOf(chatId), files.surfaceChatOf(chatId)]);
  chatsDrawnIn.set(chatId, { chat, members });
}
const unread = (chatId: string) => (error: unknown) =>
  log.warn('The chat could not be read', { chatId, message: error instanceof Error ? error.message : String(error) });

/** A row of this chat's members changed: if that moved who is in it (`rosterMoved`), read them again and tell its pages. */
export async function chatMembersChanged(chatId: string, changes: readonly MemberChange[]): Promise<void> {
  // No page drawn for it: nobody keeps its members current, so they are forgotten — read afresh when a page is (`pushContext`).
  if (![...bindings.values()].some((binding) => binding.chatId === chatId)) {
    chatsDrawnIn.delete(chatId);
    return;
  }
  if (!rosterMoved(chatsDrawnIn.get(chatId)?.members ?? null, changes)) return;
  await readChatMembers(chatId).catch(unread(chatId));
  for (const [webContentsId, binding] of bindings) if (binding.chatId === chatId) pushContext(webContentsId);
}

/**
 * The session a page is drawn in, as `getContext().session` gives it (真源原则 13): its agent — the id an App names it by
 * (`user:<uuid>`, F35) — its project, and, with `files:read`/`:write`, its working copy, found the one way main
 * finds a session's (`agentSessionContext`). Read when asked: none of it is the page's to say.
 */
async function sessionOf(binding: SurfaceBinding): Promise<ExtensionSession | undefined> {
  const sessionId = binding.sessionId;
  if (!sessionId) return undefined;
  // A session on another machine: where it is, and what that machine's list says of it. Its path is that machine's.
  const elsewhere = await sessionMachineOf(sessionId);
  if (elsewhere) {
    return {
      id: sessionId,
      ...(elsewhere.agentId ? { agentId: elsewhere.agentId } : {}),
      ...(elsewhere.projectId ? { projectId: elsewhere.projectId } : {}),
      deviceId: elsewhere.deviceId,
      ...(elsewhere.deviceLabel ? { deviceLabel: elsewhere.deviceLabel } : {}),
    };
  }
  const [{ agentSessionContext }, roster] = await Promise.all([
    import('@main/core/extensions/extension-agent-context'),
    import('@main/core/sessionpage/sessionpage-session-agent'),
  ]);
  const [facts, agents] = await Promise.all([agentSessionContext(sessionId), roster.agentIdsBySession(process.env)]);
  const capabilities = extensionsService().grantedCapabilities(binding.extensionId);
  // Absent means "not granted": handing back the path regardless would say where the working copy is after a no.
  const mayReachWorkspace = capabilities.includes('files:read') || capabilities.includes('files:write');
  const agentId = agents.get(sessionId);
  return {
    id: sessionId,
    ...(agentId ? { agentId } : {}),
    ...(facts?.projectId ? { projectId: facts.projectId } : {}),
    ...(mayReachWorkspace && facts?.workspaceRoot ? { root: fs.realpathSync(facts.workspaceRoot) } : {}),
  };
}

/**
 * The machine a page's session is on when it is not this computer; null for this computer's and when the person's other
 * machines cannot say (their list is what decides — a page drawn without it reads as this computer's, as before).
 */
async function sessionMachineOf(sessionId: string): Promise<SessionMachine | null> {
  const { sessionMachine } = await import('./app-programs-elsewhere');
  return await sessionMachine(sessionId).catch((error: unknown) => {
    log.warn('The machine of a page\'s session could not be told', { sessionId, message: error instanceof Error ? error.message : String(error) });
    return null;
  });
}

/** The file this page was opened for (`ctx.file`), named where it lives. */
function handedFileOf(binding: SurfaceBinding): (AppFileRef & { id: string }) | null {
  if (binding.chatId && binding.itemId) return { chat: binding.chatId, id: binding.itemId };
  if (binding.sessionId && binding.filePath) return { session: binding.sessionId, id: binding.filePath };
  if (binding.projectId && binding.filePath) return { project: binding.projectId, id: binding.filePath };
  return null;
}

/** Which page a message or a call came from (`ExtensionPageFrom`): the place facts of its context, filled by the host. */
async function pageFrom(binding: SurfaceBinding): Promise<ExtensionPageFrom> {
  const session = await sessionOf(binding);
  const chat = binding.chatId ? chatsDrawnIn.get(binding.chatId)?.chat : undefined;
  const file = handedFileOf(binding);
  return { tabId: binding.tabId, ...(session ? { session } : {}), ...(chat ? { chat } : {}), ...(file ? { file } : {}), operator: binding.operator };
}

function contextFor(binding: SurfaceBinding, session: ExtensionSession | undefined): ExtensionHostContext {
  const capabilities = extensionsService().grantedCapabilities(binding.extensionId);
  const { locale, themeMode, fullscreen } = requireHost().presentation();
  const drawnIn = binding.chatId ? chatsDrawnIn.get(binding.chatId) : undefined;
  const file = handedFileOf(binding);
  return {
    apiVersion: EXTENSION_API_VERSION,
    tabId: binding.tabId,
    ...(binding.modal ? { modal: { data: binding.modal.data } } : {}),
    ...(drawnIn?.chat ? { chat: { ...drawnIn.chat, members: drawnIn.members } } : {}),
    ...(session ? { session } : {}),
    // Absent stays absent: a tab opened from the entry rail has no file.
    ...(file ? { file } : {}),
    operator: binding.operator,
    locale,
    themeMode: binding.themeMode ?? themeMode,
    capabilities,
    layout: { ...binding.metrics, fullscreen },
  };
}

/** The context of a caller in no session, chat or tab — the background page, a program: who it is for, never where. */
export function contextOutside(extensionId: string): ExtensionHostContext {
  const { locale, themeMode } = requireHost().presentation();
  return { apiVersion: EXTENSION_API_VERSION, locale, themeMode, capabilities: extensionsService().grantedCapabilities(extensionId) };
}

/**
 * `app_check`'s pictures: its page in light, then dark, through the same context every page gets (ui.js picks the
 * palette from `themeMode`). Only a page an agent works may be shown in a theme of its own: no host shows it.
 */
export function showAgentPageInTheme(webContentsId: number, themeMode: 'light' | 'dark' | null): void {
  const binding = bindings.get(webContentsId);
  if (binding?.operator.kind !== 'agent') throw new Error('only a page an agent works is shown in a theme of its own');
  binding.themeMode = themeMode;
  pushContext(webContentsId);
}

/** How wide this App's tab is shown in `sessionId` now, as its pane reported it — what `app_check` lays it out at (owner 10-13). */
export function shownTabWidth(extensionId: string, tabName: string, sessionId: string): number | null {
  for (const binding of bindings.values()) {
    const shown = binding.operator.kind === 'person' && binding.metrics.visible && binding.metrics.width > 0;
    if (shown && binding.extensionId === extensionId && binding.tabName === tabName && binding.sessionId === sessionId) return binding.metrics.width;
  }
  return null;
}

/** Pushes the current context to one surface. Silent if it has gone away. */
export function pushContext(webContentsId: number): void {
  const binding = bindings.get(webContentsId);
  if (!binding) return;
  const chatId = binding.chatId;
  if (chatId && !chatsDrawnIn.has(chatId)) {
    // Never pushed without its chat: no `chat` would read as not in a chat. Unread, `getContext` says so.
    void readChatMembers(chatId).then(() => chatsDrawnIn.has(chatId) && pushContext(webContentsId), unread(chatId));
    return;
  }
  const send = (session: ExtensionSession | undefined) => {
    const contents = webContents.fromId(webContentsId);
    if (bindings.get(webContentsId) !== binding || !contents || contents.isDestroyed()) return;
    sendEvent(contents, { type: 'context', context: contextFor(binding, session) });
  };
  if (!binding.sessionId) return send(undefined);
  // The rest is read as it is when the id is known, so whichever push answers last is the newest.
  void sessionOf(binding).then(send, (error: unknown) =>
    log.warn('Extension context could not be pushed', { webContentsId, error: error instanceof Error ? error.message : String(error) }),
  );
}

/** Re-pushes context to every open surface and background page — used when theme or language moves. */
export function pushContextToAllSurfaces(): void {
  for (const id of bindings.keys()) pushContext(id);
  for (const [extensionId, id] of runningExtensionBackgrounds()) hearOn(id)({ type: 'context', context: contextOutside(extensionId) });
}

/**
 * The renderer's half of the app state, before any surface's consent is applied.
 *
 * Held raw on purpose: the renderer reports what is actually on screen, and this
 * module — the one place that already knows each surface's capabilities — decides
 * what each surface gets to see. Redacting in the renderer instead would mean the
 * reporter had to know every surface's grants, and there would be two places that
 * could get it wrong.
 */
interface ReportedPane {
  paneId: string;
  focused: boolean;
  activeTab: { tabId: string; kind: string; agentId?: string; filePath?: string } | null;
}

interface ReportedAppView {
  activeSessionId: string | null;
  activeProjectId: string | null;
  panes: readonly ReportedPane[];
}

let appView: ReportedAppView = { activeSessionId: null, activeProjectId: null, panes: [] };
/** #6387 The last session view the person had on screen — survives leaving the session page. */
let lastSessionView: { sessionId: string; projectId: string } | null = null;

function sameAppView(a: ReportedAppView, b: ReportedAppView): boolean {
  if (a.activeSessionId !== b.activeSessionId || a.activeProjectId !== b.activeProjectId) return false;
  if (a.panes.length !== b.panes.length) return false;
  return a.panes.every((pane, i) => {
    const other = b.panes[i];
    if (!other) return false;
    if (pane.paneId !== other.paneId || pane.focused !== other.focused) return false;
    const l = pane.activeTab;
    const r = other.activeTab;
    if (!l || !r) return l === r;
    return (
      l.tabId === r.tabId && l.kind === r.kind && l.agentId === r.agentId && l.filePath === r.filePath
    );
  });
}

/**
 * The renderer reports what the workspace panel is showing.
 *
 * Identical reports are dropped rather than re-pushed: MobX reactions fire on
 * every observable touch, and a surface that had to diff an unchanged payload on
 * every keystroke would be paying for the privilege of learning nothing.
 */
export function setExtensionAppView(next: ReportedAppView): void {
  if (next.activeSessionId && next.activeProjectId) {
    lastSessionView = { sessionId: next.activeSessionId, projectId: next.activeProjectId };
  }
  if (sameAppView(appView, next)) return;
  appView = next;
  // The tabs report their sessions; an App sees them by the id it names agents with (F35), read once per view. A newer
  // view that takes over reads its own.
  appViewNamed = import('@main/core/sessionpage/sessionpage-session-agent')
    .then((roster) => roster.agentIdsBySession(process.env))
    .then(
      (ids) => {
        if (appView !== next) return;
        appViewAgentIds = ids;
        pushAppStateToAllSurfaces();
      },
      (error: unknown) => log.warn('Extension app state: the shown agents could not be named', { error: error instanceof Error ? error.message : String(error) }),
    );
}

/** `appView`'s sessions → the App ids of their agents; `appViewNamed` settles once they are read. */
let appViewAgentIds = new Map<string, string>();
let appViewNamed: Promise<void> = Promise.resolve();

/**
 * What the app is showing, the same for every page of an App wherever it is (真源原则 13): a page that wants to know
 * whether it is the one on screen compares `activeSessionId` with its own `context.session`. Field by field as the
 * capability words say (`redactTab`).
 */
function appStateFor(extensionId: string): ExtensionAppState {
  const capabilities = extensionsService().grantedCapabilities(extensionId);
  const { windowFocused } = requireHost().presentation();
  const mayReadAgents = extensionsService().hasCapability(extensionId, 'agents:read');
  const mayReachWorkspace = capabilities.includes('files:read') || capabilities.includes('files:write');
  return {
    windowFocused,
    activeSessionId: appView.activeSessionId,
    activeProjectId: appView.activeProjectId,
    panes: appView.panes.map((pane) => ({
      paneId: pane.paneId,
      focused: pane.focused,
      activeTab: pane.activeTab ? redactTab(pane.activeTab, mayReadAgents, mayReachWorkspace) : null,
    })),
  };
}

/** Absent means「没给我看」— never「这个 tab 不是 agent」, which `kind` answers. */
function redactTab(
  tab: { tabId: string; kind: string; agentId?: string; filePath?: string },
  mayReadAgents: boolean,
  mayReachWorkspace: boolean
): ExtensionPaneTab {
  return {
    tabId: tab.tabId,
    kind: tab.kind,
    ...(mayReadAgents && tab.agentId && appViewAgentIds.has(tab.agentId) ? { agentId: appViewAgentIds.get(tab.agentId) } : {}),
    ...(mayReachWorkspace && tab.filePath ? { filePath: tab.filePath } : {}),
  };
}

/** Pushes the current app state to every page and background page. Silent for one that has gone away. */
export function pushAppStateToAllSurfaces(): void {
  for (const [id, binding] of bindings) hearOn(id)({ type: 'appState', state: appStateFor(binding.extensionId) });
  for (const [extensionId, id] of runningExtensionBackgrounds()) hearOn(id)({ type: 'appState', state: appStateFor(extensionId) });
}

/**
 * Agents whose state moved since the last flush.
 *
 * Coalesced rather than pushed per event: a single turn produces a run of
 * transitions, and the scope filter below costs a conversation read — paying it
 * once per burst instead of once per transition is the difference between a
 * status light and a hot path. The window is short enough that a human cannot
 * see it.
 */
const pendingAgentChanges = new Set<string>();
let agentChangeFlush: ReturnType<typeof setTimeout> | null = null;
const AGENT_CHANGE_COALESCE_MS = 50;

/**
 * One agent's state moved. Called by the host from the in-process `agent:event`
 * funnel — ❌ 不在这里订阅:静态引 agentHookService 会把会话/DB 整条栈拖进桥的模块图
 * (见 `listAgents` 那条惰性 import 的理由)。
 */
export function notifyExtensionAgentsChanged(agentId: string): void {
  pendingAgentChanges.add(agentId);
  if (agentChangeFlush) return;
  agentChangeFlush = setTimeout(() => {
    agentChangeFlush = null;
    const ids = [...pendingAgentChanges];
    pendingAgentChanges.clear();
    void flushAgentChanges(ids);
  }, AGENT_CHANGE_COALESCE_MS);
}

async function flushAgentChanges(changed: string[]): Promise<void> {
  if (changed.length === 0) return;
  const { visibleAgentsForExtension } = await import('@main/core/extensions/extension-agents');
  // One visibility computation per (extension, scope), not per page: every page of an App asks the same question.
  const visibleByKey = new Map<string, Map<string, string>>();
  // Every page that may call listAgents hears of the agents it would list — wherever it is, the background page too.
  const surfaces: [number, { extensionId: string }][] = [
    ...bindings,
    ...runningExtensionBackgrounds().map(([extensionId, id]): [number, { extensionId: string }] => [id, { extensionId }]),
  ];
  for (const [id, surface] of surfaces) {
    // Never subscribed without the consent — same rule `filesChanged` follows for
    // `files:read`. The narrow word is what is checked; `agents:read:all`
    // satisfies it and widens the answer instead of unlocking a different event.
    if (!extensionsService().hasCapability(surface.extensionId, 'agents:read')) continue;
    // 变化事件只报这台电脑上的(别的电脑上的推送要逐台订阅,没做):`all-machines` 在这里与 `all` 同一份。
    const scope = agentScope(surface.extensionId, 'agents:read');
    const key = `${surface.extensionId}:${scope}`;
    let visible = visibleByKey.get(key);
    if (!visible) {
      try {
        visible = await visibleAgentsForExtension({ scope, extensionId: surface.extensionId });
      } catch (error) {
        // ❌ 不静默:一个扩展从此收不到状态变化,和「什么都没发生」在日志里长得一样。
        log.warn('Extension agent-change push: could not resolve visible agents', {
          extensionId: surface.extensionId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      visibleByKey.set(key, visible);
    }
    // `changed` are sessions; the App hears of them by the id it names agents with (F35).
    const agentIds = [...visible].filter(([, conversationId]) => changed.includes(conversationId)).map(([agentId]) => agentId);
    if (agentIds.length === 0) continue;
    const contents = webContents.fromId(id);
    if (!contents || contents.isDestroyed()) continue;
    sendEvent(contents, { type: 'agentsChanged', agentIds });
  }
}

/**
 * Tells a surface the user picked one of the entries it declared.
 *
 * Refused unless the surface is bound: an id sent to an unbound webContents
 * would be a command delivered to something main cannot attribute. Nothing is
 * interpreted here — the id is the extension's own word, handed back verbatim.
 * The person's click on it is a gesture of the page, as on the phone (Electron's userGesture): what needs one
 * (compose, clipboard, a picker) works from a command as from a click in the page.
 */
export async function invokeExtensionCommand(webContentsId: number, commandId: string): Promise<boolean> {
  const binding = bindings.get(webContentsId);
  const contents = webContents.fromId(webContentsId);
  if (!binding || !contents || contents.isDestroyed()) return false;
  await contents.executeJavaScript('0', true);
  sendEvent(contents, { type: 'command', commandId });
  return true;
}

function sendEvent(contents: WebContents, event: ExtensionHostEvent): void {
  contents.send(EXTENSION_BRIDGE_EVENT_CHANNEL, event);
}

function denied(message: string): ExtensionBridgeResponse {
  return { ok: false, code: 'denied', message };
}

/**
 * A verb that threw. `gugu.files` and `send` say which failure it was (not-found / denied / rate-limited …); an App
 * branches on that, so it is carried out rather than folded into `failed`.
 */
function failure(extensionId: string, method: string, error: unknown): ExtensionBridgeResponse {
  const failed = bridgeFailure(error);
  log.error('Extension bridge call failed', { extensionId, method, message: failed.message });
  return { ok: false, ...failed };
}

/** Send an event to every live page of one extension — its background and all its tabs. */
function deliverToEveryPage(extensionId: string, event: ExtensionHostEvent, keep: (binding: SurfaceBinding) => boolean = () => true): void {
  const backgroundId = extensionBackgroundWebContentsId(extensionId);
  const ids = new Set<number>(backgroundId === null ? [] : [backgroundId]);
  for (const [webContentsId, binding] of bindings) {
    if (binding.extensionId === extensionId && keep(binding)) ids.add(webContentsId);
  }
  for (const id of ids) {
    const contents = webContents.fromId(id);
    if (contents && !contents.isDestroyed()) sendEvent(contents, event);
  }
}

/**
 * One call, answered the same for whoever made it: its row first — who has the verb (`only`), what it needs, what an
 * agent working the page gets instead of the person's screen — then the verb. A page, the background page and a program differ only in what their context
 * holds and in the few verbs about a page itself.
 */
export async function answerCall(caller: BridgeCaller, method: string, args: Record<string, unknown>): Promise<ExtensionBridgeResponse> {
  // The gesture was read in the preload's world (and a program has none): not here.
  const refusal = callRefusal(method, args, { kind: caller.kind, has: (capability) => extensionsService().hasCapability(caller.extensionId, capability) });
  if (refusal) return { ok: false, ...refusal };
  const facts = verbFacts(method)!;
  // A page an agent works (owner 10-14): what would reach the person's screen is handed back to the agent instead — after
  // the capability, so a verb the App may not use is refused there as anywhere.
  const agentPage = caller.binding?.operator.kind === 'agent' ? agentPages.get(caller.pageId) : undefined;
  try {
    if (agentPage && facts.toAgent && (facts.gesture !== 'to-pick' || args.pick === true)) {
      await handToAgent(caller, agentPage, method, args);
      return { ok: true, value: facts.toAgent.answer };
    }
    return { ok: true, value: await dispatch(caller, method as ExtensionBridgeMethod, args) };
  } catch (error) {
    return failure(caller.extensionId, method, error);
  }
}

/**
 * The session of the agent that works this page (owner 10-14), for what it does there as itself: telling an agent, starting
 * one. None for the person's page, the background page and a program.
 */
async function operatorSession(caller: BridgeCaller): Promise<string | undefined> {
  const operator = caller.binding?.operator;
  if (operator?.kind !== 'agent') return undefined;
  const roster = await import('@main/core/sessionpage/sessionpage-session-agent');
  for (const [sessionId, agentId] of await roster.agentIdsBySession(process.env)) if (agentId === operator.id) return sessionId;
  throw new Error(`${operator.id}, the agent working this page, is no longer on this computer`);
}

/** The page a page's own verb is about (`VerbFacts.only: 'page'`): `answerCall` let no other caller through. */
function thePage(caller: BridgeCaller): SurfaceBinding {
  if (!caller.binding) throw new Error('Only a page has this');
  return caller.binding;
}

/** Which agents a tier of `agents:*` reaches for this App (F13): `ExtensionsService.agentReach` is the one answer. */
function agentScope(extensionId: string, word: 'agents:read' | 'agents:history' | 'agents:control') {
  return extensionsService().agentReach(extensionId, word);
}

/**
 * A verb whose row says `machine` (BRIDGE_VERBS): the App's own data folder and program (`GUGU_EXTENSION_DATA_DIR`) are
 * those of its place's machine (owner 10-16「程序跟着数据」) — a page in a session on another machine has it done THERE, by
 * the same implementation that machine's own pages reach (`machineVerbs`).
 */
async function machineCall(caller: BridgeCaller, method: MachineVerb, args: Record<string, unknown>): Promise<unknown> {
  const { binding, extensionId } = caller;
  if (binding?.sessionId) {
    const manifest = extensionsService().get(extensionId).manifest;
    const { followsSessionMachine } = await import('@shared/extensions/machine-call');
    if (followsSessionMachine(manifest, method, args)) {
      const { callOnSessionMachine } = await import('./app-programs-elsewhere');
      const done = await callOnSessionMachine({ extensionId, manifest }, binding.sessionId, method, args, binding.operator.kind === 'agent');
      if (done.there) return done.value;
    }
  }
  const { machineVerbs } = await import('@main/core/extensions/machine-verbs');
  // The agent that works the page (owner 10-14): the call is its, from its own session, as its own tool call would be.
  return await machineVerbs[method](extensionId, args, binding?.operator.kind === 'agent'
    ? { agent: binding.operator.id, agentSession: await operatorSession(caller) }
    : binding?.sessionId ? { sessionId: binding.sessionId } : {});
}

async function dispatch(caller: BridgeCaller, method: ExtensionBridgeMethod, args: Record<string, unknown>): Promise<unknown> {
  if (isMachineVerb(method)) return await machineCall(caller, method, args);
  const { binding, extensionId } = caller;
  switch (method) {
    case 'modalOpen': {
      const source = thePage(caller);
      const modal = appModals.open(caller.pageId, { ...source }, args);
      try {
        const installed = extensionsService().get(extensionId);
        if (!fs.statSync(path.join(installed.rootDir, modal.options.entry), { throwIfNoEntry: false })?.isFile()) throw new Error(`App modal page not found: ${modal.options.entry}`);
        await deliver(source, { kind: 'openAppModal', page: {
          id: modal.id, extensionId, appName: installed.manifest.name,
          title: modal.options.title, size: modal.options.size,
          partition: extensionPartition(extensionId), entryUrl: extensionResourceUrl(extensionId, modal.options.entry),
        } });
      } catch (error) {
        await appModals.close(modal.id, null, error instanceof Error ? error.message : String(error));
      }
      return await appModals.result(modal);
    }
    case 'modalClose':
      return await appModals.close(appModals.forPage(caller.pageId).id, args.result ?? null);
    case 'modalKey': {
      const modal = appModals.forPage(caller.pageId);
      if (args.key !== 'tab') throw Object.assign(new Error('Unknown modal keyboard action'), { code: 'invalid' });
      await deliver(modal.binding, { kind: 'focusAppModalClose', id: modal.id });
      return undefined;
    }
    case 'getContext':
      if (!binding) return contextOutside(extensionId);
      // In a chat, the members and the chat come with the first answer (not a moment later). The chat unread is said (the
      // files API's own error), never left out: no `chat` would tell the App it is not in one.
      if (binding.chatId && !chatsDrawnIn.has(binding.chatId)) await readChatMembers(binding.chatId);
      return contextFor(binding, await sessionOf(binding));

    case 'getAppState':
      await appViewNamed;
      return appStateFor(extensionId);

    case 'setTabTitle':
      // Bounded here rather than in the UI (pageArgument, the phone's host takes the same). A task's tab or a
      // group's slot header, the one way (摩擦单 F13).
      await sayAboutPage(thePage(caller), { kind: 'setTabTitle', title: pageArgument('setTabTitle', args) });
      return undefined;

    case 'setTabBadge':
      await sayAboutPage(thePage(caller), { kind: 'setTabBadge', badge: pageArgument('setTabBadge', args) });
      return undefined;

    case 'openBrowserTab': {
      const url = String(args.url ?? '');
      // Only the two schemes a person could have typed. `file:`, `gugu-ext:` and
      // custom schemes would turn "open a page" into "reach the machine".
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs can be opened');
      // In no session there is no browser tab to open it in: the person's own browser (摩擦单 F13).
      if (!binding?.sessionId) {
        await shell.openExternal(url);
        return undefined;
      }
      await deliver(binding, { kind: 'openBrowserTab', url });
      return undefined;
    }

    case 'reportError':
      await reportFrom(caller, String(args.message ?? '').slice(0, 500), args.level === 'hint' ? 'hint' : 'error');
      return undefined;

    case 'checkCounts': {
      const page = agentPages.get(caller.pageId);
      // Only a page an agent works is heard: any other that calls it changes nothing.
      if (!page) return undefined;
      page.counts = {
        writes: countOf(args.writes),
        writesPerSecond: countOf(args.writesPerSecond),
        presenceSets: countOf(args.presenceSets),
        presencePerSecond: countOf(args.presencePerSecond),
        opens: countOf(args.opens),
        opensSettled: countOf(args.opensSettled),
      };
      return undefined;
    }

    case 'sendToBackground': {
      const backgroundId = extensionBackgroundWebContentsId(extensionId);
      // 没声明 background 的扩展、或后台已经没了 —— 响亮失败。静默丢一条消息,
      // 在作者那儿的样子是「我发了,它没反应」,查起来最费。
      const contents = backgroundId === null ? undefined : webContents.fromId(backgroundId);
      if (!contents || contents.isDestroyed()) throw new Error('This App has no background instance');
      // 宿主填的,不是视图自报 —— 一个能自报上下文的视图等于能冒充别的会话。形状就是它 context 里的那几项。
      sendEvent(contents, { type: 'from-view', message: args.message, from: await pageFrom(thePage(caller)) });
      return undefined;
    }

    case 'broadcastToViews': {
      let delivered = 0;
      for (const [webContentsId, page] of bindings) {
        if (page.extensionId !== extensionId) continue;
        const contents = webContents.fromId(webContentsId);
        if (!contents || contents.isDestroyed()) continue;
        sendEvent(contents, { type: 'from-background', message: args.message });
        delivered += 1;
      }
      // 如实回「送到了几个」,❌ 不假装成功:一个视图都没开着是常态(后台本来就不依赖视图),
      // 但后台想据此决定要不要省点活儿,它得看得见这个数。
      return { delivered };
    }

    case 'spawnAgent': {
      const { spawnAgentForExtension } = await import('@main/core/extensions/extension-agents');
      // 新 agent 是一条独立的会话,照调用点名的起(引擎、模型、形态、项目、出生的对话),没点名的照这个人上次新建会话的
      // 选择 —— ❌ 不看这一页开在哪条会话旁边(真源原则 13)。
      // 不是字符串就当没给,❌ 别 `String(x)`:`spawnAgent(p, { title: x ?? null })` 会变成一条叫 null 的会话。
      const text = (key: string) => (typeof args[key] === 'string' && args[key] ? { [key]: args[key] as string } : {});
      if (args.transport !== undefined && args.transport !== 'acp' && args.transport !== 'pty') {
        throw Object.assign(new Error('transport is "acp" (a chat UI session) or "pty" (a terminal session)'), { code: 'invalid' });
      }
      return await spawnAgentForExtension({
        extensionId,
        bySession: await operatorSession(caller),
        // 首轮信封上给人看的名字,与 gugu.send 同源:装着的那份清单。
        extensionName: extensionsService().get(extensionId).manifest.name,
        prompt: String(args.prompt ?? ''),
        ...text('title'),
        ...text('harness'),
        ...text('model'),
        ...(args.transport === 'acp' || args.transport === 'pty' ? { transport: args.transport } : {}),
        ...text('project'),
        ...text('chat'),
      });
    }

    case 'send':
    case 'messageAgent': {
      const { sendFromApp, messageAgentFromApp } = await import('@main/core/extensions/extension-send');
      // As whoever works the page (owner 10-14): its agent writes the whisper as itself, and is the one telling an agent.
      const operator = binding?.operator;
      const sent =
        method === 'send'
          ? await sendFromApp(extensionId, { to: args.to, text: args.text, chat: args.chat, refs: args.refs, about: args.about }, operator?.kind === 'agent' ? { as: operator.id.replace(/^user:/, '') } : {})
          : await messageAgentFromApp(extensionId, { agentId: args.agentId, text: args.text, queue: args.queue, defer: args.defer, key: args.key }, { from: await operatorSession(caller) });
      return { id: sent.id, ...('deferred' in sent && sent.deferred ? { deferred: true } : {}) };
    }

    case 'messagesHistory':
    case 'messagesSearch': {
      const { messagesForApp } = await import('@main/core/extensions/extension-send');
      // Read as whoever reads this chat's files for this caller: the person, or the agent the page or the call works for.
      const place = { chat: typeof args.chat === 'string' ? args.chat.toLowerCase() : '' };
      const { asAgent } = asCallingAgent(caller, caller.filePage({ place }), { place });
      return await (method === 'messagesHistory' ? messagesForApp.history : messagesForApp.search)(args, { asAgent: asAgent ?? null });
    }

    case 'chatsList': {
      const files = await import('@main/core/extensions/app-files');
      // The chats whoever reads is in: an agent's call lists its agent's alone (none known: none), a page an agent works
      // its agent's, anything else the person's.
      if (caller.callingAgent === null) throw Object.assign(new Error('This call has no agent to list chats as'), { code: 'denied' });
      return { chats: await files.chatsOf({ asAgent: caller.callingAgent ?? caller.filePage({}).asAgent ?? null }) };
    }

    case 'projectsList': {
      const [{ getProjects }, { isImplicitSessionHomeProjectId }] = await Promise.all([
        import('@main/core/projects/operations/getProjects'),
        import('@shared/core/projects/session-home-project'),
      ]);
      return { projects: (await getProjects()).filter((project) => !isImplicitSessionHomeProjectId(project.id)).map(({ id, name }) => ({ id, name })) };
    }

    case 'forumList':
    case 'forumRead':
    case 'forumPost':
    case 'forumReply':
    case 'forumReact':
    case 'forumRemove':
    case 'forumBlock':
    case 'forumAssign':
    case 'forumAward': {
      // 论坛 (9): as the person, whoever works the page — the database judges who may see and do what (app-forum-core.ts).
      const { forumForApp: forum } = await import('@main/core/extensions/extension-send');
      switch (method) {
        case 'forumList': return await forum.list(args);
        case 'forumRead': return await forum.read(args.postId);
        case 'forumReply': return await forum.reply(args.postId, args.text, { replyTo: args.replyTo });
        case 'forumReact': return await forum.react(args);
        case 'forumRemove': return await forum.remove(args);
        case 'forumBlock': return await forum.block(args.userId, args.on);
        case 'forumPost': {
          if (args.bounty === undefined || args.bounty === null) return await forum.postPlain(args);
          // Points move only behind the window's own sheet: it posts if the person confirms (ForumConsent).
          await deliver(thePage(caller), { kind: 'forumConsent', detail: { type: 'bounty', draft: forum.bountyDraft(args) } });
          return { confirming: true };
        }
        case 'forumAssign':
          // The person picks one of their own agents in the window's list (ForumConsent): an App never lists them.
          await deliver(thePage(caller), { kind: 'forumConsent', detail: { type: 'assign', draft: await forum.assignDraft(args.postId, args.agentId) } });
          return { confirming: true };
        default: {
          await deliver(thePage(caller), { kind: 'forumConsent', detail: { type: 'award', draft: await forum.awardDraft(args.postId, args.awards) } });
          return { confirming: true };
        }
      }
    }

    case 'forumSubscribe':
    case 'forumUnsubscribe':
      await watchForum(caller, args.target, method === 'forumSubscribe');
      return undefined;

    case 'chatsMembers': {
      const [files, { chatOf }] = await Promise.all([import('@main/core/extensions/app-files'), import('@shared/extensions/app-messages-core')]);
      // As whoever reads this chat's messages for this caller: an agent's call only a chat it handed (or a handed file's).
      const place = { chat: chatOf(args) };
      const { asAgent } = asCallingAgent(caller, caller.filePage({ place }), { place });
      return { members: await files.chatMembersOf(place.chat, { asAgent: asAgent ?? null }) };
    }

    case 'stopAgent': {
      const { visibleAgentsForExtension, stopAgentForExtension } = await import('@main/core/extensions/extension-agents');
      // 只要 id 集,不要整份视图:后者会去读 ACP 活会话摘要,而那一步会把运行时
      // 进程启起来——一次范围检查不该有那种副作用。
      const scope = agentScope(extensionId, 'agents:control');
      const visibleAgents = await visibleAgentsForExtension({ scope, extensionId });
      const agentId = String(args.agentId ?? '');
      // 停只在这台电脑上:`:all-machines` 让 messageAgent 够到别的电脑,❌ 让一条别处的 agent 在这里报成「看不见」。
      if (scope === 'all-machines' && !visibleAgents.has(agentId)) {
        throw new Error(`${agentId} is not an agent on this computer — stopAgent acts only here (messageAgent reaches your other computers)`);
      }
      await stopAgentForExtension({ agentId, visibleAgents, bySession: await operatorSession(caller) });
      return undefined;
    }

    case 'readAgentHistory': {
      // 可见集合从 listAgents 那条同一条路算出来,而不是另写一遍过滤:「能看见谁」只有一个答案。
      // history 的范围独立于 read 的范围——一个扩展可以只声明 history:all,所以这里查的是 history 自己那档。
      const { visibleAgentsForExtension, readAgentHistoryForExtension } = await import('@main/core/extensions/extension-agents');
      const visibleAgents = await visibleAgentsForExtension({ scope: agentScope(extensionId, 'agents:history'), extensionId });
      // 游标原样过桥:它是运行时的 seq,不是这一层能编的东西。给了非数就当没给
      // ——❌ 别 `Number(x) || undefined` 悄悄把一个坏游标变成「从头读」。
      const before = args.before;
      if (before !== undefined && typeof before !== 'number') throw Object.assign(new Error('before must be a number, or absent'), { code: 'invalid' });
      return await readAgentHistoryForExtension({ agentId: String(args.agentId ?? ''), visibleAgents, ...(before === undefined ? {} : { before }) });
    }

    case 'listAgents': {
      // 范围在这里定,而且只在这里定:门禁查的是窄的那个词,宽窄之差不体现为「能不能调」,而体现为「答得多宽」。
      // 惰性 import:静态引它会把会话/DB/日志整条栈拖进桥的模块图;桥是每次 IPC 都要过的路,它的依赖越少越好。
      const { listAgentsForExtension } = await import('@main/core/extensions/extension-agents');
      const { agents, unreached } = await listAgentsForExtension({ scope: agentScope(extensionId, 'agents:read'), extensionId });
      // 问不到的机器(离线、太旧、没回话)不在清单里,记一条,❌ 静默。
      for (const machine of unreached) log.warn('listAgents: another machine was not read', { extensionId, ...machine });
      return agents;
    }

    case 'compose': {
      // Whose composer the call names (真源原则 13), never the page's: a chat's (brought up by the window), or a session's
      // — brought on screen first, as a banner's click brings it. Naming none, the person picks one in the window's sheet
      // (the page's own session comes ticked) and the App hears where, or that they cancelled.
      const [{ composeTarget }, { composeNamesPlace, pickComposePlace }] = await Promise.all([
        import('@main/core/extensions/extension-send'),
        import('@shared/extensions/app-send-core'),
      ]);
      const page = thePage(caller);
      const picked = composeNamesPlace(args) ? null : await pickComposePlace(args, async ({ tasks }) => {
        const { pickComposeTarget } = await import('@main/core/extensions/extension-bridge-relay');
        return pickComposeTarget(page.embedderId, { tasks, current: page.sessionId });
      });
      if (picked && 'cancelled' in picked) return picked;
      const target = await composeTarget({ text: args.text, chat: args.chat, session: args.session, refs: args.refs, about: args.about, images: args.images, ...picked });
      if ('session' in target) {
        await bringSessionUp({ sessionId: target.session.id, projectId: target.session.projectId });
        await deliver(page, { kind: 'compose', sessionId: target.session.id, text: target.text });
      } else {
        await deliver(page, { kind: 'compose', detail: target });
      }
      return picked ?? undefined;
    }

    case 'notify': {
      // What a click opens is the call's to say (`open`), wherever the page that posts it is.
      const { showExtensionNotification } = await import('@main/core/extensions/extension-notifications');
      return await showExtensionNotification({ extensionId, request: args });
    }

    case 'linkTo': {
      const { linkTo } = await import('./gugu-links');
      const { linkTargetOf } = await import('@gugu/core/shared/ui/guguLink');
      return linkTo(linkTargetOf(args, extensionsService().get(extensionId).manifest), args.external === true);
    }

    case 'filesOpen':
    case 'filesReopen':
    case 'filesClose':
    case 'filesList':
    case 'filesSearch':
    case 'filesRecent':
    case 'filesCreate':
    case 'filesRemove':
    case 'filesReplace':
    case 'filesVersions':
    case 'filesReadVersion':
    case 'filesRename':
    case 'filesMkdir':
    case 'filesMove': {
      const files = await import('@main/core/extensions/app-files');
      // Every call names where its file is (真源原则 13); the caller only says which file it may open as handed. Closing
      // what it opened is never refused.
      const page = method === 'filesClose' ? caller.filePage(args) : asCallingAgent(caller, await resourcePage(caller, args), args);
      const verbs = {
        filesOpen: 'openAppFile',
        filesReopen: 'reopenAppFile',
        filesClose: 'closeAppFile',
        filesList: 'listAppFiles',
        filesSearch: 'searchAppFiles',
        filesRecent: 'recentAppFiles',
        filesCreate: 'createAppFile',
        filesRemove: 'removeAppFile',
        filesRename: 'renameAppFile',
        filesMkdir: 'makeAppFolder',
        filesMove: 'moveAppFile',
        filesReplace: 'replaceAppFile',
        filesVersions: 'appFileVersions',
        filesReadVersion: 'readAppFileVersion',
      } as const satisfies Record<typeof method, keyof typeof files>;
      return await (files[verbs[method]] as (on: typeof page, input: never) => unknown)(page, args as never);
    }

    case 'filesWatch':
      if (typeof args.watchId !== 'string' || !args.watchId) throw Object.assign(new Error('A file watch needs its subscription id'), { code: 'invalid' });
      await watchFiles(caller, args.watchId, placeOf(args.place), args.on !== false);
      return undefined;

    case 'filesUpload': {
      const files = await import('@main/core/extensions/app-files');
      const page = asCallingAgent(caller, await resourcePage(caller, args), args);
      const place = placeOf(args.place);
      // `pick` only ever arrives from the preload's gesture-checked path — a page's: a background page or a program
      // uploads bytes it has (G5), it never opens the person's picker.
      if (args.pick === true && caller.kind !== 'page') {
        throw Object.assign(new Error(`files.upload(place, file): ${CALLER_WORDS[caller.kind]} uploads the bytes it has; only a page opens the picker`), { code: 'invalid' });
      }
      // The window the page is drawn in: the picker sits on it.
      const shown = args.pick === true ? thePage(caller) : null;
      const owner = shown?.embedderId == null ? null : (webContents.fromId(shown.embedderId) ?? null);
      const picked = args.pick === true ? await files.pickFilesToUpload(owner) : (args.files as never);
      if (!Array.isArray(picked)) throw Object.assign(new Error('files.upload takes files, or none to pick'), { code: 'invalid' });
      // 子文件夹: the folder they go in, when the call names one.
      if (picked.length === 0) return [];
      return args.folder === undefined
        ? await files.uploadAppFiles(page, place, picked, args.sourceMessageIds)
        : await files.uploadAppFiles(page, place, picked, args.sourceMessageIds, args.folder);
    }

    case 'filesDownload':
    case 'filesOpenWith':
    case 'showMessage': {
      const files = await import('@main/core/extensions/app-files');
      const shown = thePage(caller);
      const page = method === 'showMessage' ? caller.filePage(args) : await resourcePage(caller, args);
      // The window the page is drawn in: dialogs sit on it, and it is the one that shows chats.
      const owner = shown.embedderId === null ? null : (webContents.fromId(shown.embedderId) ?? null);
      if (method === 'filesDownload') return await files.downloadAppFile(page, args as never, owner);
      if (method === 'filesOpenWith') {
        // 「用 X 打开」 where the file lives: a working-copy file opens in its session's pane, here; a chat file — who
        // claims it (opensFiles.chat), the person's remembered choice among several — the window that shows the chat
        // opens. `ask` is 「用别的 App 打开」: every App that opens it, the person picks (摩擦单 F2, 真源 §2.6). `at`: the
        // place a pill in the page points at, told the App that opens it as a file link in the chat tells it (`groupFileOpener`).
        // `peek` (G1): beside the page, in its own slot — the page stays as it is; a chat file nobody here opens shows in
        // the host's preview there, so nothing is refused for want of an App.
        const ask = (args as { ask?: unknown }).ask === true;
        const peek = (args as { peek?: unknown }).peek === true;
        const target = await files.openWithTarget(page, { ref: args.ref, ask, peek });
        if (target.kind === 'session') return undefined;
        if (target.kind === 'peek') return void (await deliver(shown, { kind: 'peek', target: target.target }));
        const choice = files.openerChoice(target.target.typedName, ask);
        const { chatId, itemId } = target.target;
        const place = placeFor(choice, (args as { at?: unknown }).at);
        if (place) deliverToOpeningPage(place.candidate.extensionId, placeLink(place.candidate, place.at, itemId), { chat: chatId }, itemId);
        const detail = { ...target.target, choice };
        if (peek) return void (await deliver(shown, { kind: 'peek', target: { kind: 'chat', detail } }));
        await deliver(shown, { kind: 'openWith', detail });
        return undefined;
      }
      await deliver(shown, { kind: 'showMessage', detail: await files.messageToShow(args as never) });
      return undefined;
    }

    case 'showSession': {
      // The session the call names, wherever the page is (真源原则 13): here, or on another computer the task list shows.
      // The window's list is asked over the App command channel (the relay imports this file: imported when asked).
      const [{ showSession, sessionHere }, { listedSessionProject }] = await Promise.all([
        import('@main/core/extensions/extension-show-session'),
        import('@main/core/extensions/extension-bridge-relay'),
      ]);
      // `peek` (G1): the session's own page beside the page that asked, in its slot — found the same way.
      const bringUp = (args as { peek?: unknown }).peek === true
        ? (session: { sessionId: string; projectId: string }) => deliver(thePage(caller), { kind: 'peek', target: { kind: 'session', ...session } })
        : bringSessionUp;
      await showSession(args.id, { projectHere: sessionHere, projectListed: listedSessionProject, bringUp });
      return undefined;
    }

    case 'openLink': {
      const { openLink } = await import('./gugu-links');
      const outcome = await openLink(typeof args.url === 'string' ? args.url : '');
      if (outcome.kind !== 'opened') {
        throw Object.assign(new Error(outcome.kind === 'failed' ? `That link did not open: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}` : 'Only gugu resource links open here; use gugu.openBrowserTab for a web page.'), { code: outcome.kind === 'failed' ? 'failed' : 'invalid' });
      }
      return undefined;
    }

    case 'clipboardWriteText':
      // The gesture was checked in the preload (the only world a page cannot reach).
      await clipboard.writeText(pageArgument('clipboardWriteText', args));
      return undefined;

    default:
      // Unreachable: the method table is checked before dispatch. Kept so a new
      // entry without a case fails loudly instead of resolving to undefined.
      throw new Error(`Unimplemented bridge method: ${String(method)}`);
  }
}

/**
 * A notification of this App's program on another machine (`extensions.program.notified`, handed on by this computer's
 * window): delivered to the pages here drawn in a session on that machine — the pages whose `callProgram` runs there.
 */
export async function deliverProgramNotificationFrom(
  deviceId: string,
  notification: { extensionId: string; server: string; method: string; params?: unknown },
): Promise<void> {
  const event: ExtensionHostEvent = {
    type: 'programNotification',
    server: notification.server,
    method: notification.method,
    ...(notification.params === undefined ? {} : { params: notification.params }),
  };
  for (const [webContentsId, binding] of [...bindings]) {
    if (binding.extensionId !== notification.extensionId || !binding.sessionId) continue;
    if (knownSessionMachine(binding.sessionId)?.deviceId !== deviceId) continue;
    const contents = webContents.fromId(webContentsId);
    if (contents && !contents.isDestroyed()) sendEvent(contents, event);
  }
}

export function registerExtensionBridge(): void {
  onExtensionProgramNotification((extensionId, server, notification) => {
    const params = notification.params === undefined ? {} : { params: notification.params };
    // This computer's program speaks to the pages of this computer's places: a page drawn in a session on another machine
    // has that machine's program (and hears it through deliverProgramNotificationFrom).
    deliverToEveryPage(extensionId, { type: 'programNotification', server, method: notification.method, ...params },
      (binding) => !binding.sessionId || !knownSessionMachine(binding.sessionId));
    // And to every window connected to this machine: a page on another computer may be drawn in a session here.
    events.emit(extensionProgramNotifiedChannel, { extensionId, server, method: notification.method, ...params });
  });
  ipcMain.handle(
    EXTENSION_BRIDGE_CHANNEL,
    async (event: IpcMainInvokeEvent, raw: unknown): Promise<ExtensionBridgeResponse> => {
      const request = (raw ?? {}) as ExtensionBridgeRequest;
      const method = typeof request.method === 'string' ? request.method : '';
      const args = (request.args ?? {}) as Record<string, unknown>;

      // Shell controls share the App request channel, restricted to the recorded owning window.
      if (method === 'modalHost') {
        try {
          const modal = appModals.get(String(args.id ?? ''));
          if (event.sender.id !== modal.binding.embedderId) return denied("Only this modal's host window may control it");
          switch (args.type) {
            case 'bind': {
              if (typeof args.webContentsId !== 'number') throw new Error('Missing modal content page');
              const source = modal.binding;
              const child = webContents.fromId(args.webContentsId);
              if (!bindings.has(modal.opener) || !child || child.hostWebContents?.id !== source.embedderId) {
                throw new Error('The App modal and its opener must be in the same window');
              }
              appModals.bind(modal.id, args.webContentsId);
              try {
                await bindExtensionSurface({
                  webContentsId: args.webContentsId, extensionId: source.extensionId,
                  tabId: source.tabId, tabKind: `${source.extensionId}.${source.tabName}`,
                  ...(source.sessionId ? { sessionId: source.sessionId } : {}),
                  ...(source.chatId ? { chatId: source.chatId } : {}),
                  ...(source.itemId ? { itemId: source.itemId } : {}),
                  ...(source.filePath ? { filePath: source.filePath } : {}),
                  ...(source.projectId ? { projectId: source.projectId } : {}),
                  operator: source.operator, modal: { id: modal.id, data: modal.options.data },
                });
              } catch (error) {
                await appModals.close(modal.id, null, error instanceof Error ? error.message : String(error));
                throw error;
              }
              break;
            }
            case 'dismiss':
              await appModals.close(modal.id, null, typeof args.error === 'string' ? args.error : undefined);
              break;
            case 'focus':
              if (args.edge !== 'first' && args.edge !== 'last') throw new Error('Unknown modal focus edge');
              if (modal.child !== null) hearOn(modal.child)({ type: 'modalFocus', edge: args.edge });
              break;
            default: throw new Error('Unknown modal host action');
          }
          return { ok: true, value: undefined };
        } catch (error) { return failure('host', 'modalHost', error); }
      }

      // Identity from the session the call arrived on. Everything else in the
      // payload is data an untrusted page chose.
      const extensionId = extensionIdForSession(event.sender.session);
      if (!extensionId) {
        return denied('This surface is not an App surface');
      }
      // A runtime may subscribe before its host binds it. Capture its document before that first wait too.
      const documentWatches = method === 'filesWatch' ? fileWatchesFor(event.sender.id) : null;
      if (documentWatches) {
        const contents = webContents.fromId(event.sender.id);
        if (contents) observeDocument(contents);
      }

      // 后台实例没有绑定,也不该有 —— 它不是一格面,没有会话、没有 tab、没有布局。身份仍旧由 session 认
      // (与视图同一条),再比对它确实是我们自己拉起的那个 webContents:于是一个视图伪称自己是后台也做不成后台。
      if (extensionBackgroundWebContentsId(extensionId) === event.sender.id) {
        return await answerCall(backgroundCaller(extensionId, event.sender.id), method, args);
      }
      // 还没绑上就先等一等 —— 扩展启动时调的动词跑在绑定之前是常态,不是错误。
      // 见 `waitForBinding` 上面那段:等待有上限,等不到照旧响亮失败。
      if (!bindings.has(event.sender.id)) await waitForBinding(event.sender.id);
      if (documentWatches && pageWatches.get(event.sender.id) !== documentWatches) return { ok: true, value: undefined };
      const binding = bindings.get(event.sender.id);
      if (!binding || binding.extensionId !== extensionId) {
        return { ok: false, code: 'failed', message: 'This page is not bound yet' };
      }
      return await answerCall(pageCaller(binding, event.sender.id), method, args);
    }
  );
  // The theme a page loads in, for its first paint (EXTENSION_THEME_CHANNEL): what its context will say. The page is
  // loading, so it may not be bound yet — then the host's theme, which is what its context says too.
  ipcMain.on(EXTENSION_THEME_CHANNEL, (event) => {
    event.returnValue = bindings.get(event.sender.id)?.themeMode ?? requireHost().presentation().themeMode;
  });
}

/** Test seam: read a binding without going through Electron. */
export function extensionSurfaceBindingForTests(webContentsId: number): SurfaceBinding | undefined {
  return bindings.get(webContentsId);
}
