import { fileRefOf, type AppFileEntry, type AppFileOpened, type AppFileSearch, type AppFileRef, type AppFileUpload, type AppFileVersion, type AppFileVersionContent, type AppPlace } from '@shared/extensions/app-runtime-protocol';
import type { BridgeErrorCode, ErrorDetail, ExtensionFileChangeBatch, PageCounts } from '@shared/extensions/bridge-protocol';
import type { AppSessionIndexOptions, AppSessionIndex, AppSessionReadOptions, AppSessionRead } from '@shared/extensions/app-sessions';

/**
 * What the preload exposes as `window.__guguHost` and the runtime builds `window.gugu` from.
 *
 * Only the part the runtime itself calls is typed here; every other member is copied onto
 * `window.gugu` verbatim (`gugu-entry.ts`), so the v1 verbs keep their preload-side types.
 */
export interface GuguHost {
  readonly sessions?: {
    index(options?: AppSessionIndexOptions): Promise<AppSessionIndex>;
    read(options: AppSessionReadOptions): Promise<AppSessionRead>;
  };
  readonly modal?: {
    open(options: Record<string, unknown>): Promise<unknown>;
    close(result?: unknown): Promise<void>;
    key(key: string): Promise<void>;
  };
  onModalFocus?(handler: (edge: 'first' | 'last') => void): () => void;
  readonly apiVersion: number;
  /** An iframe of the outer gugu page (the phone), not a desktop webview: `framed-host.ts`. */
  readonly framed?: boolean;
  /** An App's MCP program, not a page (F16, `program-entry.ts`): its open files show no presence. */
  readonly program?: boolean;
  /**
   * The theme the page loads in, known before its first line (the desktop preload asks main synchronously,
   * `EXTENSION_THEME_CHANNEL`): gugu.js puts it on `<html>` before the first paint. Not on `window.gugu` — the App reads
   * the theme from its context. A phone frame has none: its host answers only by message, after the first paint.
   */
  readonly theme?: 'light' | 'dark';
  /** The page `app_check` runs (摩擦单 F69, `CHECK_PAGE_ARG`): it says how often it wrote, set presence and opened files. */
  readonly checkPage?: { report(counts: PageCounts): Promise<void> };
  /** `level: 'hint'` (摩擦单 F62): for the App's author, not a sign it is broken — recorded, but no red dot. Default `error`. */
  reportError(message: string, options?: { level?: 'error' | 'hint' }): Promise<void>;
  onFilesChanged(handler: (watchId: string, change: ExtensionFileChangeBatch) => void): () => void;
  /** Every call names where its file is (`AppPlace`, `AppFileRef`, 真源原则 13). */
  readonly appFiles: {
    open(args: { ref: AppFileRef; readOnly?: boolean; appData?: boolean; deferDetails?: boolean; expectedVersion?: number }): Promise<AppFileOpened>;
    reopen(args: { ref: AppFileRef; readOnly?: boolean }): Promise<AppFileOpened>;
    close(args: { docName: string }): Promise<void>;
    /** `folder` (子文件夹): only what is directly in that folder; not given, every file of the place. */
    list(args: { place: AppPlace; folder?: string }): Promise<AppFileEntry[]>;
    /** Across every chat the reader is in: by a piece of the path, newest first; the ones this person opened last. */
    search(args: AppFileSearch): Promise<AppFileEntry[]>;
    recent(args: { limit?: number }): Promise<AppFileEntry[]>;
    viewPreferences(args: { place: AppPlace; showAppData?: boolean }): Promise<{ showAppData: boolean }>;
    create(args: { place: AppPlace; name: string; content: string; contentType?: string; sourceMessageIds?: string[]; folder?: string; appData?: boolean }): Promise<AppFileEntry>;
    /** 子文件夹: a chat's folder at `path`, made all the way down; one already there is answered as it is. */
    mkdir(args: { place: AppPlace; path: string }): Promise<AppFileEntry>;
    /** 子文件夹: into another folder (`folder`, '' the top; not given, where it is), renamed too when `name` is given. */
    move(args: { ref: AppFileRef; folder?: string; name?: string }): Promise<AppFileEntry>;
    remove(args: { ref: AppFileRef }): Promise<void>;
    rename(args: { ref: AppFileRef; name: string }): Promise<AppFileEntry>;
    watch(args: { watchId: string; place: AppPlace; on: boolean }): Promise<void>;
    replace(args: { ref: AppFileRef; file: AppFileUpload; expectedVersion?: number | null }): Promise<AppFileEntry>;
    versions(args: { ref: AppFileRef }): Promise<AppFileVersion[]>;
    readVersion(args: { ref: AppFileRef; n: number }): Promise<AppFileVersionContent>;
    /** Bytes the caller has, or (no `files`) the person's picker — which only a page has, inside a gesture. */
    upload(args: { place: AppPlace; files?: AppFileUpload[]; sourceMessageIds?: string[]; folder?: string }): Promise<AppFileEntry[]>;
    /** The gesture halves: a page's only (`VerbFacts.only`) — a background page and a program have none. */
    openWith?(args: { ref: AppFileRef; ask?: boolean; at?: Record<string, string>; peek?: boolean }): Promise<void>;
    download?(args: { ref: AppFileRef }): Promise<boolean>;
  };
  readonly clipboard?: {
    writeText(text: string): Promise<void>;
  };
  /** `gugu.messages` (`app-messages-core.ts`): each call names its chat. */
  readonly messages?: {
    history(args: Record<string, unknown>): Promise<unknown>;
    search(args: Record<string, unknown>): Promise<unknown>;
  };
  /** `gugu.projects`: this computer's projects, each one's folder a place (`{ project: id }`). */
  readonly projects?: {
    list(): Promise<unknown>;
  };
  /** `gugu.chats` (`app-files-core.ts`): the chats whoever reads is in; `members` names its chat. */
  readonly chats?: {
    list(): Promise<unknown>;
    members(args: Record<string, unknown>): Promise<unknown>;
  };
  /** `gugu.forum` (9, `app-forum-core.ts`): a page's; `onChanged` is composed of subscribe and `onForumChanged`. */
  readonly forum?: {
    list(query?: Record<string, unknown>): Promise<unknown>;
    read(postId: string): Promise<unknown>;
    post(draft: Record<string, unknown>): Promise<unknown>;
    reply(postId: string, text: string, options?: Record<string, unknown>): Promise<unknown>;
    react(reaction: Record<string, unknown>): Promise<unknown>;
    remove(what: Record<string, unknown>): Promise<unknown>;
    block(userId: string, on: boolean): Promise<unknown>;
    assign(postId: string, agentId?: string): Promise<unknown>;
    award(postId: string, awards: unknown): Promise<unknown>;
    subscribe(target: string): Promise<unknown>;
    unsubscribe(target: string): Promise<unknown>;
  };
  onForumChanged?(handler: (target: string, change: { kind: string; seq?: number; entityId?: string }) => void): () => void;
}

/**
 * `code` is what an App branches on; the message is for the person reading the console. The host's codes
 * (`BRIDGE_ERROR_CODES`), and the two only the runtime itself says:
 * - `read-only`: a write to a file opened read-only;
 * - `file-unavailable`: `files.open(…)` got no answer from the file service in time (摩擦单 F28): the message says at which step.
 */
export type GuguErrorCode = BridgeErrorCode | 'read-only' | 'file-unavailable';

export function guguError(code: GuguErrorCode, message: string, detail?: ErrorDetail): Error & { code: GuguErrorCode; detail?: ErrorDetail } {
  const error = new Error(message) as Error & { code: GuguErrorCode; detail?: ErrorDetail };
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

/**
 * A rejection from the host bridge, back into what an App expects: an Error with `code`.
 * The preload rejects with a plain `{ code, message }` because contextBridge would strip `code`
 * from an Error (extension-bridge-preload.ts `call`).
 */
export function rethrowCoded(reason: unknown): never {
  if (reason && typeof reason === 'object' && !(reason instanceof Error)) {
    const { code, message, detail } = reason as { code?: unknown; message?: unknown; detail?: ErrorDetail };
    if (typeof code === 'string' && typeof message === 'string') throw guguError(code as GuguErrorCode, message, detail);
  }
  throw reason;
}

/** The same function, its promise's rejection turned into a coded Error. */
export function coded<F extends (...args: never[]) => unknown>(fn: F): F {
  return ((...args: Parameters<F>) => {
    const result = fn(...args);
    return result instanceof Promise || (result && typeof (result as Promise<unknown>).then === 'function')
      ? (result as Promise<unknown>).then(undefined, rethrowCoded)
      : result;
  }) as F;
}

/**
 * A file as the page passed it (an entry from `files.list(place)`, `ctx.file`, `{ session, id }`, a chat file's `{ id }`,
 * `{ chat | session, name }`), checked: what is not one throws `invalid`, as a coded Error.
 */
export function refOf(file: unknown): AppFileRef {
  try {
    return fileRefOf(file);
  } catch (error) {
    throw guguError('invalid', error instanceof Error ? error.message : String(error));
  }
}
