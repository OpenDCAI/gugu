import type { WorkingCopyPart } from '@shared/extensions/working-copy-upload';
import type { TabOpenIntent } from '@shared/view-state';
import { fileRefOf, type AppFileChunk, type AppFileEntry, type AppFileOpened, type AppFileSearch, type AppFileRef,
  type AppFileText, type AppFileUpload, type AppFileVersion, type AppFileVersionContent, type AppPlace } from '@shared/extensions/app-runtime-protocol';
import type { BridgeErrorCode, ErrorDetail, ExtensionFileChangeBatch, PageCounts } from '@shared/extensions/bridge-protocol';
import type { AppSessionIndexOptions, AppSessionIndex, AppSessionReadOptions, AppSessionRead } from '@shared/extensions/app-sessions';
import type { ProjectionHost } from './projection-source';

/**
 * What the preload exposes as `window.__guguHost` and the runtime builds `window.gugu` from.
 *
 * Only the part the runtime itself calls is typed here; every other member is copied onto
 * `window.gugu` verbatim (`gugu-entry.ts`), so the v1 verbs keep their preload-side types.
 */
export interface GuguHost extends ProjectionHost {
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
  navigationGo?(args: { delta: -1 | 1 }): Promise<boolean>;
  /** The page holds a Back step of its own; the host says whether it has a Back to hand over (the phone does, a desktop tab not). */
  navigationClaimBack?(claimed: boolean): Promise<boolean>;
  onBack?(handler: () => void): () => void;
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
    open(args: { ref: AppFileRef; readOnly?: boolean; deferDetails?: boolean; expectedVersion?: number }): Promise<AppFileOpened>;
    reopen(args: { ref: AppFileRef; readOnly?: boolean }): Promise<AppFileOpened>;
    close(args: { docName?: string; ref?: AppFileRef & { version?: number } }): Promise<void>;
    /** A pinned chat file or working copy, up to 512 KB at an offset, in the shared range packet. */
    read(args: { ref: AppFileRef & { version?: number }; offset: number; length: number }): Promise<AppFileChunk>;
    /** `folder` (子文件夹): only what is directly in that folder; not given, every file of the place. */
    list(args: { place: AppPlace; folder?: string }): Promise<AppFileEntry[]>;
    /** Across every chat the reader is in: by a piece of the path, newest first; the ones this person opened last. */
    search(args: AppFileSearch): Promise<AppFileEntry[]>;
    recent(args: { limit?: number }): Promise<AppFileEntry[]>;
    viewPreferences(args: { place: AppPlace; showAppData?: boolean }): Promise<{ showAppData: boolean }>;
    create(args: { place: AppPlace; name: string; content: string; contentType?: string; sourceMessageIds?: string[]; folder?: string }): Promise<AppFileEntry>;
    /** 子文件夹: a chat's folder at `path`, made all the way down; one already there is answered as it is. */
    mkdir(args: { place: AppPlace; path: string }): Promise<AppFileEntry>;
    /** 子文件夹: into another folder (`folder`, '' the top; not given, where it is), renamed too when `name` is given. */
    move(args: { ref: AppFileRef; folder?: string; name?: string }): Promise<AppFileEntry>;
    remove(args: { ref: AppFileRef }): Promise<void>;
    rename(args: { ref: AppFileRef; name: string }): Promise<AppFileEntry>;
    /** One part of a file going into a working copy: `files.upload` with bytes. */
    writeChunk(args: WorkingCopyPart): Promise<{ received: number; entry?: AppFileEntry }>;
    /** A working copy's file or folder in this computer's file manager: a page's. */
    reveal?(args: { ref: AppFileRef }): Promise<void>;
    openInApps?(args: Record<string, never>): Promise<Array<{ id: string; label: string }>>;
    openIn?(args: { ref: AppFileRef; app: string }): Promise<void>;
    /** 「设为临时 / 一直保留」: the cloud copy of a chat file this person uploaded, cleared after their temporary period or kept. */
    keep(args: { refs: AppFileRef[]; how: 'temporary' | 'permanent' }): Promise<{ changed: number }>;
    watch(args: { watchId: string; place: AppPlace & { folder?: string; id?: string }; on: boolean }): Promise<void>;
    replace(args: { ref: AppFileRef; file: AppFileUpload; expectedVersion?: number | null }): Promise<AppFileEntry>;
    readText(args: { ref: AppFileRef; maxBytes?: number; transferId?: string }): Promise<AppFileText>;
    exists(args: { ref: AppFileRef }): Promise<boolean>;
    draft(args: { ref: AppFileRef; text?: string | null }): Promise<string | null>;
    writeText(args: { ref: AppFileRef; text: string }): Promise<{ entry: AppFileEntry }>;
    /** Whether whoever reads may delete each file, in order: asked as a file's menu opens, never carried by a list. */
    canDelete(args: { refs: AppFileRef[] }): Promise<boolean[]>;
    versions(args: { ref: AppFileRef }): Promise<AppFileVersion[]>;
    readVersion(args: { ref: AppFileRef; n: number }): Promise<AppFileVersionContent>;
    /** Bytes the caller has, or (no `files`) the person's picker — which only a page has, inside a gesture. */
    upload(args: { place: AppPlace; files?: AppFileUpload[]; sourceMessageIds?: string[]; folder?: string; keep?: string }): Promise<AppFileEntry[]>;
    /** The gesture halves: a page's only (`VerbFacts.only`) — a background page and a program have none. */
    openWith?(args: { ref: AppFileRef; ask?: boolean; at?: Record<string, string>; peek?: boolean; tab?: string; intent?: TabOpenIntent; viewState?: Record<string, unknown> }): Promise<void>;
    /** One file (`true` saved), or several (API 20: how many were saved; `0` when the person cancelled). */
    download?(args: { ref: AppFileRef; folder?: boolean; transferId?: string } | { refs: AppFileRef[] }): Promise<boolean | number>;
    downloadStop?(args: { transferId: string }): Promise<void>;
    forward?(args: { refs: AppFileRef[] }): Promise<void>;
  };
  readonly clipboard?: {
    writeText(text: string): Promise<void>;
  };
  /** `gugu.messages` (`app-messages-core.ts`): each call names its chat. */
  readonly messages?: {
    history(args: Record<string, unknown>): Promise<unknown>;
    search(args: Record<string, unknown>): Promise<unknown>;
  };
  /** `gugu.projects`: this computer's projects, each one's folder a place (`{ workspace: project.workspace }`). */
  readonly projects?: {
    list(): Promise<unknown>;
  };
  /** `gugu.chats` (`app-files-core.ts`): the chats whoever reads is in; `members` names its chat. */
  readonly chats?: {
    list(): Promise<unknown>;
    members(args: Record<string, unknown>): Promise<unknown>;
  };
  /** `gugu.cloud` (31, `app-cloud-core.ts`): `on` is composed of subscribe and `onCloudHeard`; a program writes with `programWrite`. */
  readonly cloud?: {
    read(name: string, args?: Record<string, unknown>): Promise<unknown>;
    write?(name: string, args?: Record<string, unknown>): Promise<unknown>;
    programWrite?(name: string, args?: Record<string, unknown>): Promise<unknown>;
    subscribe?(topic: string, event: string): Promise<unknown>;
    unsubscribe?(topic: string, event: string): Promise<unknown>;
  };
  onCloudHeard?(handler: (topic: string, event: string, heard: { subscribed: true } | { payload: Record<string, unknown> }) => void): () => void;
  pickAgent?(ask: Record<string, unknown>): Promise<unknown>;
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
