import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import type { FileOpenerCandidate } from './file-openers';
/**
 * The App runtime's wire: what the platform script, the preload and main agree on
 * (gugu-base notes/2026-09-29-app-platform/workspace-app/L3-runtime-interface.md).
 *
 * Three facts live here and nowhere else:
 * - where the runtime is served from (a reserved path on every App origin) and the one
 *   line the host puts into an App's HTML to load it;
 * - the messages that cross the per-page sync port besides raw frames;
 * - the few bytes of a Hocuspocus frame main reads: the routing key at the front, and
 *   whether a Sync frame carries an update. Main never decodes Yjs.
 */

import runtimeVersion from './app-runtime-version.json';
import type { ErrorDetail, ExtensionHostEvent } from './bridge-protocol';

/** Every App origin serves the platform runtime under this prefix, from gugu's own files. */
export const APP_RUNTIME_PREFIX = '/_gugu/';
/**
 * Bumped when the runtime's page-facing shape changes incompatibly. The bytes under it
 * ride with the gugu build; the number is only what an old page and a new host share.
 * Kept in a JSON file because the build (vite.config.mts) reads it too.
 */
export const APP_RUNTIME_VERSION: string = runtimeVersion.version;
export const APP_RUNTIME_BASE = `${APP_RUNTIME_PREFIX}${APP_RUNTIME_VERSION}/`;
/** The classic script that builds `window.gugu`. */
export const APP_RUNTIME_ENTRY = `${APP_RUNTIME_BASE}gugu.js`;
/** Lazily imported by the entry: open files (Yjs + provider) and the editor. */
export const APP_RUNTIME_FILES_MODULE = `${APP_RUNTIME_BASE}files.js`;
export const APP_RUNTIME_CODEMIRROR_MODULE = `${APP_RUNTIME_BASE}codemirror.js`;
/**
 * Imported by `gugu.markdown()` on first use (markdown-entry.ts): the host's markdown rendering — one dialect, one
 * sanitize pass, the `.gg-md` look — and its stylesheet (`.gg-md` + KaTeX, in `@layer gugu`), which the module links.
 */
export const APP_RUNTIME_MARKDOWN_MODULE = `${APP_RUNTIME_BASE}markdown.js`;
export const APP_RUNTIME_MARKDOWN_CSS = `${APP_RUNTIME_BASE}markdown.css`;
/** Imported by an App's own app.js: the page that opens one file, its fixed half (glue-entry.ts; the template's import line). */
export const APP_RUNTIME_GLUE_MODULE = `${APP_RUNTIME_BASE}glue.js`;
/**
 * The host's look for App pages (app-runtime/ui): the stylesheet, all of it in `@layer gugu` so anything the App writes
 * wins, and the four elements (`<gugu-icon|avatar|time|empty>`). The entry writes both into every App page right after
 * itself. Shipped with gugu, never in an App's bundle.
 */
export const APP_RUNTIME_UI_CSS = `${APP_RUNTIME_BASE}ui.css`;
export const APP_RUNTIME_UI_JS = `${APP_RUNTIME_BASE}ui.js`;
/** Every element and class of the look on one page (app-runtime/ui/gallery.html): the picture guide apps-ui shows. */
export const APP_RUNTIME_UI_GALLERY = `${APP_RUNTIME_BASE}gallery.html`;
/**
 * The phone's page that forgets an App's storage in its origin when the App is uninstalled (forget-entry.ts,
 * built by the phone's bundle only — vite.config.mts phoneAppsPlugin; the desktop clears its partition instead).
 */
export const APP_RUNTIME_FORGET_PAGE = `${APP_RUNTIME_BASE}forget.html`;

/**
 * One position of a JSON file written this often a second, every second for this long, is a clock or a frame loop kept in
 * the file: the App's error record gets one hint (摩擦单 F62 / F84), which `app_check` reads back with the
 * pages' records. Nothing is refused or slowed.
 */
export const BUSY_WRITES_PER_SECOND = 3;
export const BUSY_SECONDS = 10;

/**
 * 摩擦单 F96: an App page has no `alert` / `confirm` / `prompt` — a dialog that stops the page would freeze the host, and
 * a phone's frame has none. The runtime makes each of them throw this, on both; `app_check` says the same of a
 * bundle's scripts that call one. One sentence for both, so the author reads what the guide says.
 */
export const PAGE_DIALOGS = ['alert', 'confirm', 'prompt'] as const;
export type PageDialog = (typeof PAGE_DIALOGS)[number];
export function noPageDialog(name: PageDialog): string {
  return `${name}() does not exist in an App page (a dialog that stops the page would freeze the host; a phone has none): ask on the page — an input, a button, a line of text (guide: apps-page)`;
}

/**
 * The runtime's line in an App document. The phone writes it into an installed App's pages once (L9) and notes which
 * line it wrote: only when this line changes are those pages written again.
 */
export const RUNTIME_SCRIPT_TAG = `<script src="${APP_RUNTIME_ENTRY}"></script>`;

/**
 * Puts the runtime's script tag into an App document, before any script of the App's own.
 *
 * After the doctype, never before it: anything ahead of `<!doctype html>` drops the page
 * into quirks mode. A synchronous classic script so `window.gugu` exists on the App's first
 * line. Idempotent, so a document that is served twice is not given two runtimes.
 */
export function injectAppRuntime(html: string): string {
  if (html.includes(RUNTIME_SCRIPT_TAG)) return html;
  const doctype = /^(\uFEFF?\s*<!doctype[^>]*>)/i.exec(html);
  if (!doctype) return RUNTIME_SCRIPT_TAG + html;
  const head = doctype[1]!;
  return head + RUNTIME_SCRIPT_TAG + html.slice(head.length);
}

// ─── slots outside the session page ─────────────────────────────────────────────

/**
 * The window event a slot outside the session page (a group's side panel, later the dock) claims an
 * App's resident page with, and releases it (task renderer `app-slot-events.ts`).
 */
export const APP_SLOT_EVENT = 'gugu:app-slot';

export type AppSlotEventDetail =
  | {
      type: 'claim';
      /** Stable for the slot; claiming again replaces its claim. */
      slotId: string;
      /** `<extensionId>.<tabName>` — which App page. */
      kind: string;
      /** The group the slot is drawn for; the page's context carries it (and no sessionId). */
      chatId?: string;
      /** The group file the slot opened with this App (「用 X 打开」): the page's handed-over file. */
      itemId?: string;
      /** Where to draw the page: an element of this document, on screen while claimed. */
      element: HTMLElement;
    }
  | { type: 'release'; slotId: string }
  /** The person picked one of the tab's declared toolbar / menu entries on the slot's header (摩擦单 F13). */
  | { type: 'command'; slotId: string; commandId: string };

// ─── the sync port ──────────────────────────────────────────────────────────

/** main → preload: here is this page's sync port (in `event.ports`). */
export const SYNC_PORT_CHANNEL = 'gugu-ext:sync-port';
/** preload → main world: the `window.postMessage` marker the runtime waits for. */
export const SYNC_PORT_WINDOW_MESSAGE = 'gugu-ext:sync-port';
/**
 * page → its host (the preload's world on the desktop, the outer page on the phone): «I am listening,
 * hand me my sync port». The host keeps the port until this is said (摩擦单 F28): a port posted
 * into the page before its runtime listens is simply lost, and `files.open(…)` waited for it forever.
 */
export const SYNC_PORT_REQUEST = 'gugu-ext:sync-port-request';

/** Why a page lost a open file. */
export type SyncRevokeReason =
  | 'capability'
  | 'unbound'
  | 'signed-out'
  | 'deleted'
  | 'removed-from-group';

/**
 * Control objects main sends down the port; everything else on the port is a frame
 * (an ArrayBuffer), byte for byte what the file service sent.
 */
export type SyncToPage =
  /** The machine's connection to the file service is open; the page's socket may open. */
  | { t: 'up' }
  /** It is gone; main reconnects with backoff. The page's socket closes and retries. */
  | { t: 'down'; code: number; reason: string }
  /** One frame was dropped: its routing key is not granted to this page, or it is read-only. */
  | { t: 'denied'; key: string; reason: string }
  /** A open file was taken back from this page. */
  | { t: 'revoked'; docName: string; reason: SyncRevokeReason }
  /**
   * A session working copy's file taken back as `deleted` is on the disk again (`git checkout`, an undo): the page opens
   * it again (`files.reopen`, the next generation) and is online (摩擦单 F92). Never sent for a group's file.
   */
  | { t: 'back'; docName: string };

export type SyncToMain =
  /**
   * The page's socket is (re)opening. Main closes every document connection this page still
   * holds (the server refuses a second Auth on a live one), then answers `up` or `down`.
   */
  | { t: 'hello' }
  /**
   * Local changes of `open file` the service has not confirmed, while the page is offline —
   * the whole state as one Yjs update, opaque to main. `null` clears it. If the page goes
   * away still holding one, main delivers it when it can (`L3-runtime-interface.md` §3.4-5).
   */
  | { t: 'will'; docName: string; update: ArrayBuffer | null };

// ─── files.* over the bridge ─────────────────────────────────────────────────

/**
 * Where a file lives (真源原则 13): a chat's workspace, or a folder on this computer — a session's working copy, or a
 * project's folder (`gugu.projects.list()`). Every `gugu.files` call names it — the page's own place is a fact of
 * `getContext()`, never read behind the call's back.
 */
export type AppPlace = { chat: string } | LocalPlace;

/** A folder on this computer: a session's working copy, or a project's root folder. Its files are named by their path there. */
export type LocalPlace = { session: string } | { project: string };

/**
 * A file, named so that where it lives is said: a working-copy file by its session and its path there (`id`, or `name`
 * — the same thing in a working copy); a chat file by its item id, which says its chat on its own (as `send`'s `about`
 * does; an entry also carries `chat`, checked when given), or by its name in a chat — its path from the top of the chat's
 * folder when it is in a subfolder (`合同/2026/甲方.pdf`; a name is never cut by `/`, gugu-supabase 20261016012659).
 */
export type AppFileRef =
  | (LocalPlace & { id: string })
  | (LocalPlace & { name: string })
  | { chat?: string; id: string }
  | { chat: string; name: string };

/** A file of a folder on this computer, as a call names it. Its name is its path there. */
export type LocalFileRef = Extract<AppFileRef, LocalPlace>;

/** Whether a place (or a file named with one) is a folder on this computer rather than a chat's. */
export const isLocal = <T extends object>(place: T): place is Extract<T, LocalPlace> => 'session' in place || 'project' in place;

/** One string per place: what a page keeps its open files and watches under (a path is only unique in its folder). */
export function placeKey(place: AppPlace): string {
  return 'chat' in place ? `chat:${place.chat}` : 'session' in place ? `session:${place.session}` : `project:${place.project}`;
}

const invalidPlace = (message: string) => Object.assign(new Error(message), { code: 'invalid' as const });

/** A chat's id, as getContext() and every entry carry it (`send` takes the same, app-send-core.ts). */
const CHAT_ID =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 编号 18 (10-12 片场试演): a chat named by anything but its id — the number people see, a name — is refused here, before
 * any file call reaches the chat's rows (where it came back as the row policy's own words).
 */
function chatIdOf(chat: string): string {
  // One spelling (148 评审): a program writing the id in capitals is still that chat, matched against handed chats by id.
  if (CHAT_ID.test(chat)) return chat.toLowerCase();
  throw invalidPlace(`chat is a chat's id, as getContext() gives it — ${JSON.stringify(chat)} is not one (a chat's number is not its id). ` +
    'A tool that takes a chat from an agent marks it format: "gugu-chat", and gugu hands it over as its id');
}

/** A place as a page passed it, checked: exactly one of `chat` (a chat's id) / `session` / `project`, a non-empty string. */
export function placeOf(value: unknown): AppPlace {
  const place = (value ?? {}) as { chat?: unknown; session?: unknown; project?: unknown };
  const named = (['chat', 'session', 'project'] as const).filter((key) => typeof place[key] === 'string' && place[key]);
  if (named.length !== 1) {
    throw invalidPlace('Say where: { chat: id } for a chat\'s files, { session: id } for a session\'s working copy — as getContext() gives them — ' +
      'or { project: id } for a project\'s folder, as gugu.projects.list() gives it');
  }
  const [key] = named;
  const id = place[key!] as string;
  return key === 'chat' ? { chat: chatIdOf(id) } : key === 'session' ? { session: id } : { project: id };
}

/** An address (`user:`, `session:`, `aid:`, …) where a session's bare id belongs. */
const ADDRESS = /^[a-z][a-z-]*:/i;

/**
 * The session `gugu.showSession(id)` names, in its one spelling: its bare id, as `ctx.session.id`, `listAgents`'
 * `sessionId` and a tool call's `call.session` give it. An address is refused, saying which to pass — never translated.
 */
export function sessionIdOf(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw invalidPlace("Say which session: its id, as ctx.session.id gives it (listAgents' sessionId, a tool call's call.session)");
  }
  if (ADDRESS.test(value)) {
    throw invalidPlace(`${JSON.stringify(value)} is an address, not a session's id: pass the session's id, as ctx.session.id gives it`);
  }
  return value;
}

/**
 * A file as a page passed it: an entry from `files.list(place)`, `ctx.file`, `{ session, id | name }`, a chat file's
 * `{ id }`, or `{ chat, name }`.
 */
export function fileRefOf(value: unknown): AppFileRef {
  if (typeof value === 'string') {
    throw invalidPlace(`Say which file ${JSON.stringify(value)} is: pass an entry or ctx.file as it is, or { chat, name } / { session, name }`);
  }
  const file = (value ?? {}) as { id?: unknown; name?: unknown; chat?: unknown; session?: unknown; project?: unknown };
  const id = typeof file.id === 'string' && file.id ? file.id : null;
  const name = typeof file.name === 'string' && file.name ? file.name : null;
  if (id === null && name === null) {
    throw invalidPlace('Say which file: pass an entry (from gugu.files.list) or ctx.file as it is, or { chat, name } / { session, name }');
  }
  if (file.session !== undefined || file.project !== undefined || (id === null && file.chat !== undefined)) {
    const place = placeOf(value);
    return id !== null ? { ...place, id } : { ...place, name: name! };
  }
  if (id !== null) {
    if (file.chat !== undefined && (typeof file.chat !== 'string' || !file.chat)) throw invalidPlace('chat is a chat\'s id, as getContext() gives it');
    return typeof file.chat === 'string' ? { chat: chatIdOf(file.chat), id } : { id };
  }
  throw invalidPlace(`Say where ${JSON.stringify(name)} is: { chat, name } or { session, name }`);
}

/** Where a file the host knows lives (an entry, `ctx.file`): its session's working copy, its project's folder, or the chat it names. */
export function placeOfFile(file: { chat?: string; session?: string; project?: string }): AppPlace {
  if (file.session) return { session: file.session };
  if (file.project) return { project: file.project };
  if (file.chat) return { chat: file.chat };
  throw invalidPlace('This file does not say where it lives');
}

/**
 * A folder as a call names it (子文件夹): its path from the top of the chat's folder (`合同/2026`), its id or its entry,
 * `''` for the top. Not given: no folder said — `files.list` lists every file, `create` and `upload` put it at the top.
 */
export function folderOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim();
  const entry = value as { id?: unknown; type?: unknown };
  if (typeof entry.id === 'string' && entry.id && entry.type === 'folder') return entry.id;
  throw invalidPlace("folder is a folder's path ('合同/2026'), its id or its entry from gugu.files.list — '' for the top");
}

/**
 * `files.search(options)` across every chat whoever reads is in: `query` a piece of the path (any case; none, every file),
 * `suffixes` the kinds kept (`['.md']`; none, all), `limit` at most so many (1-200, else 50). `files.recent({ limit })`
 * takes the `limit` alone. What is not one of these throws.
 */
export interface AppFileSearch {
  query?: string;
  suffixes?: string[];
  limit?: number;
}

export function fileSearchOf(value: unknown): AppFileSearch {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidPlace('files.search({ query, suffixes, limit }) takes an object');
  const { query, suffixes, limit } = value as Record<string, unknown>;
  if (query !== undefined && typeof query !== 'string') throw invalidPlace('query is text: a piece of the path');
  if (suffixes !== undefined && !(Array.isArray(suffixes) && suffixes.every((one) => typeof one === 'string' && /^\.[^./\\\s]+$/.test(one)))) {
    throw invalidPlace("suffixes are like ['.md', '.pptx']");
  }
  if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 200)) {
    throw invalidPlace('limit is a whole number from 1 to 200');
  }
  return {
    ...(query === undefined ? {} : { query }),
    ...(suffixes === undefined ? {} : { suffixes: (suffixes as string[]).map((one) => one.toLowerCase()) }),
    ...(limit === undefined ? {} : { limit: limit as number }),
  };
}

/** A file as the page sees it (`GuguFileEntry`) — itself a ref: `{ chat, id }` or `{ session, id }`. */
export interface AppFileEntry {
  /** A chat file: its item id. A working-copy file: its path there (POSIX). */
  id: string;
  /** Where it lives: exactly one of these (`AppPlace`). */
  chat?: string;
  session?: string;
  project?: string;
  name: string;
  contentType: string;
  /** `folder` (子文件夹): a chat folder's subfolder — listed, entered, moved, never opened. */
  type: 'text' | 'json' | 'binary' | 'folder';
  /** The folder it is in (a `folder` entry's id); `null` at the top of the chat's folder, and for a working copy's file. */
  parentId: string | null;
  /** Where it is from the top of the chat's folder (`合同/2026/甲方.pdf`); a working copy's file: its path there (its id). */
  path: string;
  /**
   * A folder gugu keeps: `attachments` is 「附件」, where a chat's attachments go — it cannot be renamed, moved or deleted
   * (what is in it can), and is shown by this role, not by its stored name. `null` for every other entry.
   */
  systemRole: 'attachments' | null;
  /** The suffix the file is known by (`fileSuffixOf`): its content type's when the type names one, else its name's. */
  suffix: string;
  /** The name as a person reads it (摩擦单 F39): without the suffix an App claims it by — `friday-dinner` for `friday-dinner.vote.json`. */
  displayName: string;
  /** The App that opens it here (the most specific claim, or the one chosen to always use); `null` when none does. */
  claimedBy: AppFileClaimant | null;
  size: number | null;
  /** A chat file's version (G1: `files.replace` makes the next one); `null` for a working copy's file. */
  version: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Who made it (真源 §2.4): `system` when no person or agent did. */
  createdBy: AppFilePerson | null;
  /** The chat messages it came from, for `gugu.showMessage` — ids only, never their content. */
  sourceMessageIds: string[];
  /**
   * Whether whoever reads (the person, or the agent a program works for) may delete it, as the folder decides (owner 10-18):
   * who made it, the owner of the agent that made it, or the chat's owner or an admin — a folder with all in it; never
   * 「附件」. A working copy's file: true on this computer.
   */
  canDelete: boolean;
  /**
   * `files.upload`'s answer only: the file of its folder that already had the name this one was picked with — the
   * database gave this one 「 (n)」 (子文件夹); `null` when it kept the name it was picked with.
   */
  clashWith?: string | null;
  /** `files.search` / `files.recent`'s answers only: the chat it is in, by the name people know it by (a private chat: the other one in it). */
  chatName?: string;
  /** `files.recent`'s answer only: when this person last opened it. */
  openedAt?: string;
}

/** An App as a file list shows it next to a file it opens. */
export interface AppFileClaimant {
  id: string;
  name: string;
  /**
   * The icon this App declared for the file's kind (its tab's `fileIcons`, by the claim that took the file) — a PNG the
   * host re-encoded, as a data URL; `null` when it declared none: the page draws a generic file mark, never the App's icon.
   */
  icon: string | null;
}

export interface AppFilePerson {
  id: string;
  name: string;
  kind: 'human' | 'agent' | 'system';
}

/**
 * G2 One kept version of a chat file (`files.versions`): a text file's each round of changes, a stored file's each
 * replaced content — newest first, the 50 kept. `n` names it for `files.readVersion`; `by` null when no one is known.
 */
export interface AppFileVersion {
  n: number;
  by: AppFilePerson | null;
  at: string;
  size: number | null;
}
/** What `files.readVersion` answers: a text file's version as its text, a stored file's as its bytes. */
export type AppFileVersionContent = { n: number; text: string } | { n: number; bytes: ArrayBuffer; contentType: string };

/** One file `files.upload` hands over: bytes read in the page, or picked by the host. */
export interface AppFileUpload {
  name: string;
  contentType: string;
  bytes: ArrayBuffer;
}

/** The workspace bucket's per-object limit (gugu-supabase 20260617090000_workspace_storage_bucket). */
export const APP_FILE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * `gugu.showMessage`: main tells the window that shows chats to bring a message of a group into
 * view (IPC channel), and the shell's preload passes it on as a window event.
 */
/**
 * The phone (真源 §2.2): the App runs in a sandboxed iframe (`allow-scripts`, an opaque origin) and
 * its host is the outer gugu page, reached by postMessage instead of a preload. The same runtime
 * builds `window.gugu` on either; only this transport differs. Every message carries the marker;
 * the outer page answers only its own iframe's window, the runtime only its parent.
 */
export const APP_FRAME_MARKER = 'gugu.app-frame.v1';
/** The meta key a tool call's own id rides on to the App's program, minted by main for that call (program-call.ts). */
export const PROGRAM_CALL_META_KEY = 'gugu/call';

export type FrameToHost =
  /**
   * A document's runtime has started (the phone): the frame's previous document, if any, is gone — the outer page's
   * `did-navigate`. Posted before anything else of this document, so it is ahead of the document's first call.
   */
  | { m: typeof APP_FRAME_MARKER; t: 'hello' }
  /** The runtime listens for its sync port now: the outer page hands it over (摩擦单 F28). */
  | { m: typeof APP_FRAME_MARKER; t: 'sync-port' }
  /** `call`: a program's request made inside one tool call — that call's id, as main minted it (program-call.ts). */
  | { m: typeof APP_FRAME_MARKER; t: 'call'; id: number; method: string; args: unknown; call?: string }
  /** A program's file sync traffic on its IPC channel (F16): what a page's sync port carries. */
  | { m: typeof APP_FRAME_MARKER; t: 'sync'; data: unknown };
export type HostToFrame =
  | { m: typeof APP_FRAME_MARKER; t: 'sync'; data: unknown }
  | { m: typeof APP_FRAME_MARKER; t: 'result'; id: number; ok: true; value: unknown }
  | { m: typeof APP_FRAME_MARKER; t: 'result'; id: number; ok: false; code: string; message: string; detail?: ErrorDetail }
  | { m: typeof APP_FRAME_MARKER; t: 'event'; event: ExtensionHostEvent };

/**
 * `gugu.files.openWith` (「用 X 打开」, 真源 §2.4): main has resolved who claims the file in the group
 * and tells the window that shows the group's side panel — which opens that App on the file, or
 * asks the person when several claim it (a choice of `chooseOpener`, never `none`).
 */
export const APP_OPEN_WITH_EVENT = 'gugu:app-open-with';
export interface AppOpenWithDetail {
  chatId: string;
  itemId: string;
  name: string;
  /** What kind of file it is (`typedFileName`): who opens it is matched by this, never by guessing from `name`. */
  typedName: string;
  choice:
    | { kind: 'one'; candidate: FileOpenerCandidate }
    | { kind: 'choose'; suffix: string; candidates: FileOpenerCandidate[] }
    /** Nobody here opens it: the group's panel offers the App that would (a shared package, the market — 161 10-15). */
    | { kind: 'none' };
}

/** A chat file as the host's preview reads it (its bytes are its version's). */
export interface ChatPeekFile {
  contentType: string;
  version: number;
  size: number;
}

/**
 * What opens beside the page that asked (`files.openWith(file, { peek: true })`, `showSession(id, { peek: true })`, G1):
 * drawn by the host in that page's own slot, the page left as it is. A chat's file: who opens it there (`none`: the host's
 * preview). A file of a folder on this computer: its workspace and path there — who claims it is the window's to work
 * out, as a click in a session's files does. A session: its own session page — on a phone, the computer it is on
 * (`deviceId`), whose timeline the phone draws.
 */
export type PeekTarget =
  | { kind: 'chat'; detail: AppOpenWithDetail; file: ChatPeekFile }
  | { kind: 'local'; place: LocalPlace; projectId: string; workspaceId: string; path: string; absolutePath: string; name: string; ask: boolean }
  | { kind: 'session'; sessionId: string; projectId: string; deviceId?: string };

/**
 * 摩擦单 F10: open a file of a group (or a topic) where the person is — a link in the chat, `session_open_in_tab`, a link
 * in a session's transcript (`gugu-file://<itemId>`, `parseGroupFileLink`). One window event, one listener (the chat shell):
 * it brings that chat up, leaves the file with whatever shows it (a group's side panel, a topic's split) and cancels the
 * event to say it took it. Not taken: the person is not in that chat (told so), and whoever asked says that, not that it
 * opened.
 */
export const GROUP_FILE_OPEN_EVENT = 'gugu:open-group-file';
export interface GroupFileOpenDetail {
  /** The chat the file is in, as the file says (F112); null when the person is not in it — they see no such file. */
  chatId: string | null;
  itemId: string;
  /** The place in it a pill points at (its link's `#…`, `parseGroupFileLink`): the App that opens it gets it as a `link` event. */
  at?: Record<string, string>;
}
export const GROUP_FILE_NOT_OPENED = 'Not opened: the person at this computer is not in the chat this file belongs to';

/** `gugu.compose` from an App in a chat's slot, desktop (main's host action) and phone alike: `useSlotMakesWay` takes it. */
export const APP_COMPOSE_EVENT = 'gugu:app-compose';
export interface AppComposeDetail {
  chatId: string;
  text: string;
  /** G3 Images beside the text, as attachments of the draft: the person sends them, or not. */
  images?: AppComposeImage[];
  /** App 引用 pill: the pills its `refs` made, held by the composer beside the text and sent under it. */
  refs?: AppComposeRef[];
}

/**
 * A pill `gugu.compose` / `gugu.send` makes of a ref (App 引用 pill, owner 10-14): its words (`<file> · <label>`) and the
 * group file link it is (`gugu-file://<id>?v=<version>#<k=v&k=v>`). A message holds it as `@[words](link)` (`pillText`).
 */
export interface AppComposeRef {
  label: string;
  link: string;
}

/** An image `gugu.compose` puts in a chat's composer (G3): bytes the page has — a crop of what was picked, say. */
export interface AppComposeImage {
  name: string;
  type: string;
  bytes: ArrayBuffer;
}
/** At most this many, each at most the size a chat attachment may be (message_send_file's 10 MiB). */
export const APP_COMPOSE_MAX_IMAGES = 9;
export const APP_COMPOSE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** A link's or a banner's click naming a chat (真源原则 13): the chat shell brings it up, its panel opens the App. */
export const APP_OPEN_IN_CHAT_EVENT = 'gugu:app-open-in-chat';
export interface AppOpenInChatDetail {
  chatId: string;
  extensionId: string;
}

/**
 * 论坛 (9): a bounty's points move only behind a sheet the host draws (components/extensionBundle/ForumConsent): posting one, and
 * settling one. The page's call answers `{ confirming: true }` once the sheet is up; the sheet does it if the person confirms.
 */
export const APP_FORUM_CONSENT_EVENT = 'gugu:app-forum-consent';
export type AppForumConsentDetail =
  | { type: 'bounty'; draft: import('./app-forum-core').BountyDraft }
  | { type: 'award'; draft: import('./app-forum-core').AwardDraft }
  /** `gugu.forum.assign`: the person picks one of their own agents in the host's list; the App never lists them. */
  | { type: 'assign'; draft: import('./app-forum-core').AssignDraft };

export const APP_SHOW_MESSAGE_EVENT = 'gugu:app-show-message';
export interface AppShowMessageDetail {
  chatId: string;
  messageId: string;
}

/** `gugu.showSession` on the phone: the task tab opens the session's row — the machine it is on, and the row as listed. */
export const APP_SHOW_SESSION_EVENT = 'gugu:app-show-session';
export interface AppShowSessionDetail {
  deviceId: string;
  session: SessionpageSessionSummary;
}

/** What `files.open` / `files.reopen` answer. */
export interface AppFileOpened {
  entry: AppFileEntry;
  /** `<itemId>@<epoch>` — the document name; the page adds its own session id. */
  docName: string;
  access: 'rw' | 'ro';
  self: { userId: string; name: string };
  /**
   * A stored file — an image, a clip, a sound, anything that is not a document: its bytes, read-only. Nothing is synced
   * for it (`docName` is empty); the page hands them over as `f.blob()`.
   */
  bytes?: ArrayBuffer;
}

/** The suffix a content type stands for (摩擦单 F41), `''` for a type that names none (bytes: `application/octet-stream`). */
const SUFFIX_OF_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'text/markdown': '.md',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/html': '.html',
};

/** A name's own suffix (the last dot-led tail, lowercased), `''` without one. A leading dot is a hidden file, not a suffix. */
function ownSuffix(name: string): string {
  const at = name.lastIndexOf('.');
  return at > 0 && at < name.length - 1 ? name.slice(at).toLowerCase() : '';
}

/**
 * What kind of file this is, as a suffix — the one answer for who opens it and how it shows (摩擦单 F41): its content
 * type's, when the type names one — the type is also what the file is served as (`fileTypeOf`), and a document's name is
 * a title (`栖页 2.0 发布页` has no suffix `.0 发布页`). Only a type that names none (stored bytes) goes by the name's.
 * The file is never renamed: names are people's and agents'.
 */
export function fileSuffixOf(file: { name: string; contentType?: string | null }): string {
  const type = (file.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return SUFFIX_OF_CONTENT_TYPE[type] || ownSuffix(file.name);
}

/**
 * The name a file is matched by against `opensFiles`: its own when it already ends in its type's suffix
 * (`friday.vote.json` stays, for a `.vote.json` claim), else with that suffix added.
 */
export function typedFileName(file: { name: string; contentType?: string | null }): string {
  const suffix = fileSuffixOf(file);
  return file.name.toLowerCase().endsWith(suffix) ? file.name : `${file.name}${suffix}`;
}

export function fileTypeOf(kind: string, contentType: string): AppFileEntry['type'] {
  if (kind === 'folder') return 'folder';
  if (kind !== 'document') return 'binary';
  return /json/i.test(contentType) ? 'json' : 'text';
}

// ─── Hocuspocus 4.7 frames: the part main reads ──────────────────────────────

export const FRAME_TYPE = {
  Sync: 0,
  Awareness: 1,
  Auth: 2,
  QueryAwareness: 3,
  Stateless: 5,
  Close: 7,
  SyncStatus: 8,
  Ping: 9,
  Pong: 10,
} as const;

const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;
const AUTH_TOKEN = 0;
const AUTH_PERMISSION_DENIED = 1;
const AUTH_AUTHENTICATED = 2;

/** A routing key is `<documentName>\0<sessionId>` (provider `sessionAwareness: true`). */
export function splitRoutingKey(key: string): { docName: string; hocuspocusSessionId: string | null } {
  const at = key.indexOf('\0');
  return at === -1 ? { docName: key, hocuspocusSessionId: null } : { docName: key.slice(0, at), hocuspocusSessionId: key.slice(at + 1) };
}

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  get done(): boolean {
    return this.pos >= this.bytes.length;
  }
  varUint(): number {
    let num = 0;
    let mult = 1;
    for (;;) {
      if (this.pos >= this.bytes.length) throw new RangeError('truncated varUint');
      const byte = this.bytes[this.pos++]!;
      num += (byte & 0x7f) * mult;
      if (byte < 0x80) return num;
      mult *= 128;
      if (mult > 2 ** 53) throw new RangeError('varUint too large');
    }
  }
  varBytes(): Uint8Array {
    const len = this.varUint();
    if (this.pos + len > this.bytes.length) throw new RangeError('truncated bytes');
    const out = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  varString(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.varBytes());
  }
}

class Writer {
  private readonly parts: number[] = [];
  varUint(value: number): this {
    let v = value;
    while (v > 0x7f) {
      this.parts.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    this.parts.push(v);
    return this;
  }
  varBytes(bytes: Uint8Array): this {
    this.varUint(bytes.length);
    for (const b of bytes) this.parts.push(b);
    return this;
  }
  varString(text: string): this {
    return this.varBytes(new TextEncoder().encode(text));
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** What main needs to know about one frame. `null` for bytes that are not a keyed frame. */
export interface FrameHead {
  key: string;
  type: number;
  /** Sync frames only: whether it would change the document (Step 2 with content, or Update). */
  carriesUpdate: boolean;
}

/** The empty Yjs update: no structs, empty delete set. A Step 2 carrying only this changes nothing. */
function isEmptyYjsUpdate(update: Uint8Array): boolean {
  return update.length === 2 && update[0] === 0 && update[1] === 0;
}

export function readFrameHead(frame: Uint8Array): FrameHead | null {
  try {
    const r = new Reader(frame);
    const key = r.varString();
    const type = r.varUint();
    let carriesUpdate = false;
    if (type === FRAME_TYPE.Sync) {
      const step = r.varUint();
      if (step === SYNC_UPDATE) carriesUpdate = true;
      else if (step === SYNC_STEP_2) carriesUpdate = !isEmptyYjsUpdate(r.varBytes());
    }
    return { key, type, carriesUpdate };
  } catch {
    return null;
  }
}

/** The Yjs update a Sync frame carries (Step 2 or Update), or null for any other frame. */
export function readFrameUpdate(frame: Uint8Array): Uint8Array | null {
  try {
    const r = new Reader(frame);
    r.varString();
    if (r.varUint() !== FRAME_TYPE.Sync) return null;
    const step = r.varUint();
    return step === SYNC_UPDATE || step === SYNC_STEP_2 ? r.varBytes() : null;
  } catch {
    return null;
  }
}

/** A lone Ping / Pong byte: the only frames without a routing key. */
export function isBareFrame(frame: Uint8Array, type: number): boolean {
  return frame.length === 1 && frame[0] === type;
}

export function encodeCloseFrame(key: string): Uint8Array {
  return new Writer().varString(key).varUint(FRAME_TYPE.Close).toBytes();
}

export function encodeAuthFrame(key: string, token: string): Uint8Array {
  return new Writer().varString(key).varUint(FRAME_TYPE.Auth).varUint(AUTH_TOKEN).varString(token).toBytes();
}

export function encodeSyncUpdateFrame(key: string, update: Uint8Array): Uint8Array {
  return new Writer().varString(key).varUint(FRAME_TYPE.Sync).varUint(SYNC_UPDATE).varBytes(update).toBytes();
}

/** The service's answer to an Auth frame, when that is what `frame` is. */
export function readAuthAnswer(frame: Uint8Array): { key: string; ok: true } | { key: string; ok: false; reason: string } | null {
  try {
    const r = new Reader(frame);
    const key = r.varString();
    if (r.varUint() !== FRAME_TYPE.Auth) return null;
    const kind = r.varUint();
    if (kind === AUTH_AUTHENTICATED) return { key, ok: true };
    if (kind === AUTH_PERMISSION_DENIED) return { key, ok: false, reason: r.done ? 'permission-denied' : r.varString() };
    return null;
  } catch {
    return null;
  }
}

/** The service closing one document connection (`Close`, e.g. `removed-from-group`), when that is what `frame` is. */
export function readCloseFrame(frame: Uint8Array): { key: string; reason: string } | null {
  try {
    const r = new Reader(frame);
    const key = r.varString();
    if (r.varUint() !== FRAME_TYPE.Close) return null;
    return { key, reason: r.done ? '' : r.varString() };
  } catch {
    return null;
  }
}

/** The service's save acknowledgement (`SyncStatus`), when that is what `frame` is. */
export function readSyncStatus(frame: Uint8Array): { key: string; saved: boolean } | null {
  try {
    const r = new Reader(frame);
    const key = r.varString();
    if (r.varUint() !== FRAME_TYPE.SyncStatus) return null;
    return { key, saved: r.varUint() === 1 };
  } catch {
    return null;
  }
}

/**
 * How an App sees a person or an agent: `user:<uuid>`, exactly as the MCP tools write it (摩擦单 F35) — the same
 * person has one spelling on the agent's side and the App's. Services hand out bare uuids; the runtime's edge
 * turns them into this, so neither side has to guess which form it holds.
 */
export function personId(id: string): string {
  return id.startsWith('user:') ? id : `user:${id}`;
}

/**
 * The name the phone gives the frame of an App drawn in a session's tab (`<iframe name>`; the page reads it as `window.name`
 * before its own code runs). Only that frame offers `callProgram` / `onProgramNotification`: a chat's panel has no computer.
 */
export const APP_SESSION_FRAME_NAME = 'gugu:session';
