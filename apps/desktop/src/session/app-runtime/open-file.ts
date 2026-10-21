import { HocuspocusProvider, type HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import {
  BUSY_SECONDS,
  BUSY_WRITES_PER_SECOND,
  personId,
  placeKey,
  placeOfFile,
  type AppFileEntry,
  type AppFileOpened,
  type SyncRevokeReason,
} from '@shared/extensions/app-runtime-protocol';
import { guguError, type GuguHost } from './host';
import { mapProxy, mergeValue } from './json-proxy';
import { keepReplacedMaps } from '@gugu/files-core/concurrent';
import { applyEdit, readText } from '@gugu/files-core/content';
import { WORKSPACE_TEXT_MAX_BYTES } from '@gugu/core/shared/workspaceUpload.mjs';
import { applyFromSnapshot } from './apply-from';
import { countsOf } from './check-counts';
import { pageSocket, restPageSocket, syncLink } from './sync-link';

/**
 * One file this page opened: its replica (a Y.Doc), the provider that keeps it in step with
 * the open file, and the handles the App holds.
 *
 * Every `files.open(…)` of the file on this page gets a handle of its own on this one replica
 * (摩擦单 F46): closing a handle lets go of it and of the handlers registered through it, and
 * the file closes with its last handle. A handle never changes identity. What can change underneath is the replica:
 * when the file service compacts a file it moves it to a new epoch, and a copy from the old
 * epoch is refused (`stale-epoch:<n>`). The file then reopens at the new epoch, replays what
 * this page had not got confirmed, and carries on — the App sees one `onChange`, and an
 * editor binding re-attaches itself (`onSwap`).
 */

export type FileStatus = 'online' | 'offline' | 'gone';
type TextDelta = Array<{ retain: number } | { insert: string } | { delete: number }>;

export interface Peer {
  id: string;
  userId: string;
  name: string;
  color: string;
  state: unknown;
}

/** What an editor binding needs and the App never sees. */
export interface FileInternals {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly awareness: NonNullable<HocuspocusProvider['awareness']>;
  readonly readOnly: boolean;
  onSwap(handler: () => void): () => void;
  /** Hold the open file's incoming updates until the returned release (IME commit window; `SyncLink.hold`). */
  holdRemote(): () => void;
  /**
   * See each incoming update while nothing is held; `holdRemote()` from inside holds that update too (`SyncLink.inspect`).
   * An inspector that throws is dropped (reported through `reportError`); the update lands as usual.
   */
  inspectRemote(inspector: (update: Uint8Array) => void): () => void;
  /** On the phone: also hold for the whole soft-keyboard session (L1 方案 B, 真源 §4). */
  readonly keyboardSession: boolean;
}

export const internals = new WeakMap<object, OpenFile | FieldText>();

/** A `textAt` handle's subscription: the field it follows, and the Y.Text it was last seen as. */
interface FieldWatcher {
  path: readonly (string | number)[];
  last: Y.Text | undefined;
  handler: (event: { local: boolean; delta?: TextDelta }) => void;
}

export type RefusedReason = 'too-large' | 'rate-limited';

const JSON_CONTENT_TYPE = 'application/json';

/** Why a JSON file's `edit(old, new)` changed nothing, in the words its text file's edit uses. */
function jsonEditRefusal(body: { error?: string; message?: string }): Error {
  if (body.error === 'content-changed') return guguError('content-changed', 'old is not in the file (it changed, or it does not match exactly)', { reason: 'old-not-found' });
  if (body.error === 'ambiguous') return guguError('ambiguous', 'old matches more than once; include more context', { reason: 'old-matches-many' });
  if (body.error === 'too-large') return guguError('too-large', `the edit would take the file past ${WORKSPACE_TEXT_MAX_BYTES} bytes; nothing was changed`);
  return guguError('invalid', `the edit would not leave a JSON object (${body.message ?? body.error}); nothing was changed`);
}

/** What this page wrote that a new replica must be given again: one replacement with its context, or JSON keys. */
type Pending = { text: ReturnType<typeof diffOnce>; context: [string, string] } | { json: Record<string, unknown> } | null;

/** Back-off after the service closed a document connection for load (`rate-limited`). */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
const WILL_DELAY_MS = 200;
/** A paused file's changes wait in the provider's batch for this long (F71): the longest timer there is, never reached. */
const HELD_MS = 2 ** 31 - 1;
/** Reopens at a new epoch in a row with no sync between them (refused as stale each time): one more and the file is gone. */
const MAX_REOPENS = 3;
/**
 * How long an open file may wait on the file service — for its sync after (re)connecting, or to confirm
 * a change — before it says so, goes offline and connects again (摩擦单 F46: it sat at `online` and
 * "Saving" with nothing moving).
 */
export const STALL_MS = 10_000;

/** One `files.open(…)`'s hold on the file. */
interface Handle {
  closed: boolean;
  /** Unsubscribes what was registered through this handle. */
  readonly off: Set<() => void>;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * JSON with every object's keys in one order: two replicas holding the same data read the same, whatever order their
 * keys arrived in (a replica rebuilt from an update integrates them by client, not by time — 摩擦单 F71).
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** The smallest single replacement that turns `before` into `after`. */
function diffOnce(before: string, after: string): { at: number; removed: string; inserted: string } | null {
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB -= 1;
    endA -= 1;
  }
  return { at: start, removed: before.slice(start, endB), inserted: after.slice(start, endA) };
}

export class OpenFile {
  entry: AppFileEntry;
  readonly readOnly: boolean;
  docName: string;
  status: FileStatus = 'offline';
  doc!: Y.Doc;
  provider!: HocuspocusProvider;
  /** What the open file had confirmed last time nothing of ours was pending — the base a replay diffs from. */
  private confirmed: { text: string } | { json: Record<string, unknown> } | null = null;
  private readonly changeHandlers = new Set<(event: { local: boolean; delta?: TextDelta }) => void>();
  private readonly statusHandlers = new Set<(status: FileStatus) => void>();
  private readonly presenceHandlers = new Set<(others: readonly Peer[]) => void>();
  private readonly fieldWatchers = new Set<FieldWatcher>();
  private readonly swapHandlers = new Set<() => void>();
  private readonly refusedHandlers = new Set<(event: { reason: RefusedReason }) => void>();
  private retryMs = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private detachDoc: (() => void) | null = null;
  private presenceState: unknown = null;
  private willTimer: ReturnType<typeof setTimeout> | null = null;
  /** The document a will of this file's is held for in main (`flushWill`), until the file is saved again. */
  private willPosted: string | null = null;
  private reopens = 0;
  private closed = false;
  private destroyedProvider: HocuspocusProvider | null = null;
  private rateLimitSaid = false;
  private socket: HocuspocusProviderWebsocket | null = null;
  private readonly handles = new Set<Handle>();
  /** Last `unsyncedChanges` count, and when the file service last moved for this file (see `watchStall`). */
  private unsynced = 0;
  private progressAt = 0;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private stallSaid = false;
  /** Per position of the JSON, writes per second over the last BUSY_SECONDS (the last entry is the second now), and whether the hint was given. */
  private writesAt = new Map<string, number[]>();
  private writesSecond = 0;
  private busySaid = false;
  private everReady = false;
  private connecting: { reject: (error: Error) => void } | null = null;
  /**
   * A hot compaction draining this file (摩擦单 F71): the page's document frames are paused, and `shadow` is the file as the
   * service will hold it — the replica when the pause began, and from then on only what others write.
   */
  private compaction: { shadow: Y.Doc; drained: boolean; held: boolean; stop: () => void } | null = null;
  /** Replaying onto a new replica in a swap: those writes are not change events (the swap says the net one). */
  private swapping = false;
  /**
   * A gone file come back (摩擦单 F92) filling its new replica from the service: those remote transactions are not change
   * events (`cameBack` says the net one). The App may write meanwhile — offline writes are allowed — and those are its
   * own: heard, and kept by a will (L3's review).
   */
  private filling = false;
  /** Reopening at a new epoch (a compaction, 摩擦单 F71): one at a time; a close meanwhile waits for it (`closeAfterSwap`). */
  private reopening = false;
  private closeAfterSwap = false;
  readonly self: Peer;

  constructor(
    private readonly host: GuguHost,
    opened: AppFileOpened,
  ) {
    this.entry = opened.entry;
    this.docName = opened.docName;
    this.readOnly = opened.access === 'ro';
    this.self = {
      id: '',
      userId: opened.self.userId,
      name: opened.self.name,
      // Nobody's colour is made up here (摩擦单 F9): the file service stamps everyone's, this page's
      // own included (`self`, below). Empty until it has — the App draws its default for that moment.
      color: '',
      state: null,
    };
  }

  /** A new handle on this file: what one `files.open(…)` hands the App. */
  handle(): object {
    // Opened again while a close waited for a swap: it stays open.
    this.closeAfterSwap = false;
    const handle: Handle = { closed: false, off: new Set() };
    this.handles.add(handle);
    const file = this.type === 'json' ? this.makeJsonFile(handle) : this.makeTextFile(handle);
    internals.set(file, this);
    return file;
  }

  /** A handle let go: its handlers go with it, and the file closes with the last one. */
  private release(handle: Handle): void {
    if (handle.closed) return;
    handle.closed = true;
    for (const off of handle.off) off();
    handle.off.clear();
    this.handles.delete(handle);
    if (this.handles.size > 0) return;
    if (unanswered === 0) this.close();
    else whenAnswered.push(() => this.handles.size === 0 && this.close());
  }

  get type(): 'text' | 'json' {
    return this.entry.type === 'json' ? 'json' : 'text';
  }

  get epoch(): string {
    return this.docName.slice(this.docName.lastIndexOf('@') + 1);
  }

  get saved(): boolean {
    // No provider yet (still opening): nothing of this page's is waiting to be saved.
    return !this.provider?.hasUnsyncedChanges;
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  /**
   * How far `connect` got — named in `file-unavailable` when it never finishes (摩擦单 F28): waiting for the
   * sync port from the host, for the machine's connection, or for the open file's first sync.
   */
  stage: 'port' | 'connection' | 'sync' | 'ready' = 'port';

  /** Attaches a replica to the open file and resolves once it holds the open file's content. */
  async connect(): Promise<void> {
    await this.replica(false);
    this.captureConfirmed();
  }

  /**
   * A replica on the open file, resolved once it holds the open file's content. `staged` (a swap, 摩擦单 F71): it syncs
   * beside the one the App uses, and the file moves onto it only when the answer's function is called — so the App reads
   * and writes the replica it had until that one synchronous step, and nothing written meanwhile goes astray.
   */
  private async replica(staged: boolean): Promise<() => void> {
    syncing.add(this);
    this.stage = 'port';
    const socket = await pageSocket();
    // Let go of, past its deadline or taken back while the port was on its way: no provider for it.
    if (this.closed || this.status === 'gone') throw guguError('failed', `${this.entry.name} was closed or taken back while opening`);
    this.socket = socket;
    this.stage = socket.status === 'connected' ? 'sync' : 'connection';
    const doc = new Y.Doc();
    // What this page wrote into a map that lost to one made at the same moment must still reach the file service,
    // which merges the two (摩擦单 F43) — the same rule the service runs.
    if (this.type === 'json') keepReplacedMaps(doc);
    let settle!: { resolve: () => void; reject: (error: Error) => void };
    const ready = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // A refusal or a revocation before the first sync ends the wait with its reason (`gone`), not the deadline.
    this.connecting = settle;
    void ready.then(
      () => (this.connecting = null),
      () => (this.connecting = null),
    );
    /** Whether the file has taken this replica (`take`): a staged one is not the file's until then. */
    let taken = false;
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: this.docName,
      document: doc,
      // The page holds no credential: main's connection was authenticated when it opened.
      token: '',
      // Several pages share one connection, and one page may open a file twice:
      // `<docName>\0<session>` keeps every provider's frames apart.
      sessionAwareness: true,
      onSynced: () => {
        // Synced means the open file answered: this replica is online, whatever event order got us here.
        // Nothing else says online — a connected socket is not a file the service is keeping (摩擦单 F46).
        this.stage = 'ready';
        this.everReady = true;
        this.stallSaid = false;
        this.retryMs = 0;
        // MAX_REOPENS bounds reopens that never get anywhere, not a file's whole life: synced, the count starts again.
        this.reopens = 0;
        this.setStatus('online');
        this.progressed();
        settle.resolve();
      },
      onAuthenticationFailed: ({ reason }) => {
        // Refused: the service holds no connection on this key. Off the page's socket without a Close of ours —
        // Hocuspocus 4.7 keeps a frame on a key that has not authenticated until it does, which a refused key never will
        // (one per compaction, piling up until the full queue resets main's whole socket).
        socket.configuration.providerMap.delete(provider.effectiveName);
        provider.detach();
        // A staged replica refused before the file took it (the epoch moved again meanwhile): the swap that asked for it
        // hears why. Once taken it is the file's like any other — a later refusal (stale after the next compaction,
        // not-found) is the file's to act on, never a word to a swap long settled.
        if (!taken) settle.reject(guguError('failed', `Could not reopen ${this.entry.name}: ${reason}`));
        else void this.authenticationFailed(reason, settle);
      },
    });
    const take = () => {
      taken = true;
      this.doc = doc;
      this.provider = provider;
      this.unsynced = provider.unsyncedChanges;
      this.self.id = String(this.doc.clientID);
      this.observe();
    };
    // Until the file has taken it (`take`), a staged replica's events are not the file's.
    provider.on('status', ({ status }: { status: string }) => {
      if (this.provider !== provider) return;
      if (status !== 'connected') {
        // A pause is for the connection it began on: the resync sends everything the service lacks.
        this.endCompaction();
        this.setStatus('offline');
        return;
      }
      // Online once this file has synced again (`onSynced`); the wait for it starts now.
      if (this.stage === 'connection') this.stage = 'sync';
      this.progressed();
    });
    provider.on('unsyncedChanges', ({ number }: { number: number }) => {
      if (this.provider !== provider) return;
      // A change confirmed, or a wait just begun: the stall clock starts again. More changes queued behind an unanswered one do not reset it.
      if (number < this.unsynced || this.unsynced === 0) this.progressed();
      this.unsynced = number;
      this.unsyncedMoved();
    });
    // The service closed THIS document connection while the socket stays up (the socket's own
    // close arrives with the socket already disconnected). The provider does not come back from
    // that by itself; `documentClosed` decides what does.
    provider.on('close', ({ event }: { event?: { reason?: unknown } }) => {
      if (this.provider !== provider || socket.status !== 'connected') return;
      // Let go of it without a Close of our own: the service has no connection left to close, so Hocuspocus 4.7 keeps
      // that frame until this key authenticates again — then closes the new connection with it ('provider_initiated',
      // every retry after a `rate-limited`) — or, for a key never reopened (a compaction's, a reload's), for as long as
      // main's socket lives, counted against the queue that resets the whole socket when full.
      socket.configuration.providerMap.delete(provider.effectiveName);
      provider.detach();
      void this.documentClosed(String(event?.reason ?? ''));
    });
    provider.awareness?.on('change', () => {
      if (this.provider === provider) this.emitPresence();
    });
    // Nor is it anyone in the file for the others: no local presence state at all.
    if (this.host.program) provider.awareness?.setLocalState(null);
    // Who this page is, as the file service says once it has authenticated this document connection:
    // the same stamp it puts on this person's presence for everyone else (真源 §2.4, 摩擦单 F9).
    // And the service's word about compacting it while it is open (摩擦单 F71). A staged replica is not the file's until
    // taken: a `compact` that reaches it before then goes unanswered, the service gives up after its drain window and
    // tries again after its cooldown — known, and harmless (L3's review).
    provider.on('stateless', ({ payload }: { payload: string }) => {
      if (this.provider === provider) this.fromService(payload);
    });
    if (!staged) take();
    // Set before it attaches, so the sync carries it: on a new replica, the others see this page again at once.
    this.publishPresence(provider.awareness);
    provider.attach();
    try {
      await ready;
    } catch (error) {
      // A staged replica that never became the file's (refused — the epoch moved on again — or taken back meanwhile)
      // goes here, or it stays on the page's socket for good and authenticates again on every reconnect. Out of the
      // socket's map first: the service holds no connection for a key it refused, so a Close of ours would only wait
      // at the service for the next Auth on it.
      if (!taken) {
        socket.configuration.providerMap.delete(provider.effectiveName);
        provider.detach();
        provider.destroy();
        doc.destroy();
      }
      throw error;
    }
    return staged ? take : () => undefined;
  }

  private observe(): void {
    this.detachDoc?.();
    // Filling a new replica (its first sync, the replay) is not a change the App sees: the swap says the net one.
    if (this.type === 'text') {
      const text = this.doc.getText('content');
      const handler = (event: Y.YTextEvent, transaction: Y.Transaction) => {
        if (this.swapping || (this.filling && !transaction.local)) return;
        this.emitChange({ local: transaction.local, delta: event.delta as TextDelta });
        if (transaction.local) this.localChanged();
      };
      text.observe(handler);
      this.detachDoc = () => text.unobserve(handler);
    } else {
      const root = this.doc.getMap('root');
      const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
        if (this.swapping || (this.filling && !transaction.local)) return;
        this.emitChange({ local: transaction.local });
        this.emitFieldChanges(events, transaction.local);
        if (transaction.local) {
          this.localChanged();
          this.countWrites(events);
        }
      };
      root.observeDeep(handler);
      this.detachDoc = () => root.unobserveDeep(handler);
    }
  }

  private async authenticationFailed(
    reason: string,
    settle: { resolve: () => void; reject: (error: Error) => void },
  ): Promise<void> {
    if (reason.startsWith('stale-epoch:') && this.reopens < MAX_REOPENS) {
      this.reopens += 1;
      try {
        await this.reopenAtNewEpoch();
        settle.resolve();
      } catch (error) {
        const failed = error instanceof Error ? error : new Error(String(error));
        // Still opening: the open hears why. Open already (refused on a reconnect): connect again — the refused provider
        // is off the socket, so nothing else would; the next refusal counts toward MAX_REOPENS.
        if (!this.everReady) settle.reject(failed);
        else if (!this.closed && this.status !== 'gone') {
          this.warn(`could not reopen at the file's new epoch (${failed.message}); connecting again`);
          await this.documentClosed('reopen-failed');
        }
      }
      return;
    }
    const code = reason === 'not-found' ? 'not-found' : reason === 'not-a-member' ? 'denied' : 'failed';
    settle.reject(guguError(code, `Could not open ${this.entry.name}: ${reason}`));
    this.gone();
  }

  /**
   * The reasons the file service closes one document connection (L2, 真源 §2.2):
   * - `deleted` / `removed-from-group`: over for good — main also revokes the open file;
   * - `too-large`: the service refused what we sent. Resending would loop, so the local change
   *   is taken back (the replica is rebuilt from the open file) and the page is told (`onRefused`);
   * - `rate-limited`, or anything unknown: step back, then authenticate again — what this
   *   replica has that the open file lacks goes out with the next sync.
   */
  private async documentClosed(reason: string): Promise<void> {
    if (this.status === 'gone' || this.closed) return;
    if (reason.startsWith('compacted:') || reason === 'compacting') {
      await this.reopenAfterCompaction();
      return;
    }
    // Any other close ends a pause: the resync sends everything the service lacks.
    this.endCompaction();
    if (reason === 'deleted' || reason === 'removed-from-group') {
      this.gone(undefined, reason);
      return;
    }
    if (reason === 'too-large') {
      this.emitRefused('too-large');
      // Said by the runtime, as a rate limit is — the slot's error record, every App alike (L11 A6); onRefused is for
      // an App that wants to say more.
      // In words a person reads in the slot and an agent reads back (摩擦单 F108): which file, and why.
      void this.host.reportError(`${this.entry.name} is over its size limit; the last change was undone.`);
      await this.reloadFromService();
      return;
    }
    if (reason === 'rate-limited') {
      this.emitRefused('rate-limited');
      // Said by the runtime, once per file, not left to the App's onRefused (摩擦单 F70): a page that writes far more
      // than a person types (every frame of an animation into the file — F62's hint says where that goes).
      if (!this.rateLimitSaid) {
        this.rateLimitSaid = true;
        void this.host.reportError(`${this.entry.name} was changed too fast; it reconnects, and what was not saved yet goes out then.`);
      }
    }
    this.setStatus('offline');
    this.retryMs = Math.min(this.retryMs ? this.retryMs * 2 : RETRY_MIN_MS, RETRY_MAX_MS);
    const provider = this.provider;
    provider.detach();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.provider === provider && this.status !== 'gone' && !this.closed) provider.attach();
    }, this.retryMs);
  }

  // ─── stalls ───────────────────────────────────────────────────────────────

  /** The file service moved for this file (connected, synced, confirmed a change): a wait on it starts from now. */
  private progressed(): void {
    this.progressAt = Date.now();
    this.watchStall();
  }

  /** What this file is waiting on the file service for, while its socket is up — nothing when it is not waiting. */
  private waitingFor(): 'sync' | 'confirmation' | null {
    if (this.closed || this.status === 'gone' || this.socket?.status !== 'connected' || !this.provider.isAttached) return null;
    // Paused for a compaction (摩擦单 F71, L3 #3): the wait is the service's drain and swap, not a stall; it restarts after.
    if (this.compaction) return null;
    if (!this.provider.synced) return 'sync';
    return this.provider.hasUnsyncedChanges ? 'confirmation' : null;
  }

  /**
   * Once the file has been ready (before that, `files.open(…)`'s own deadline speaks): waiting on the
   * service for STALL_MS with nothing moving is a stall, not "Saving".
   */
  private watchStall(): void {
    if (this.stallTimer || !this.everReady || !this.waitingFor()) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      const waiting = this.waitingFor();
      if (!waiting) return;
      if (Date.now() - this.progressAt < STALL_MS) this.watchStall();
      else this.stalled(waiting);
    }, Math.max(0, this.progressAt + STALL_MS - Date.now()));
  }

  /**
   * Said out loud, once per stall: the App's error record names what it waited for, `status` goes
   * `offline` (`onStatus` fires), and the file connects again the way it does after the service closed
   * it — what this replica has that the open file lacks goes out with the next sync.
   */
  private stalled(waiting: 'sync' | 'confirmation'): void {
    if (!this.stallSaid) {
      this.stallSaid = true;
      const what = waiting === 'sync' ? 'sync' : 'confirmation of a change';
      void this.host.reportError(`gugu: ${this.entry.name}: the file service did not answer for ${STALL_MS / 1000} s (waiting for: ${what}); offline, connecting again`);
    }
    // What the provider does when the service closes a document connection, for one that went silent.
    this.provider.onClose();
    void this.documentClosed('no-answer');
  }

  /** Throw away what this replica has beyond the open file, and start again from the open file. */
  private async reloadFromService(): Promise<void> {
    await this.swapReplica(() => null);
  }

  /** What the App reads of the file now, to tell whether a swap changed it. */
  private contentNow(): string {
    return this.type === 'text' ? this.doc.getText('content').toString() : canonical(this.doc.getMap('root').toJSON());
  }

  /**
   * Moves the file onto a new replica (摩擦单 F71). The new one syncs beside the one the App uses; then, in one
   * synchronous step, what this page wrote (`pendingOf`, asked at that moment, so nothing written meanwhile is missed)
   * is replayed onto it and the file takes it. Nothing of the move shows: status stays as it was, filling the replica fires
   * no change events, and one change says what really changed — none when nothing did. Bindings re-attach (`onSwap`),
   * `textAt` handles follow their field, `f.data` stays the same object.
   */
  private async swapReplica(pendingOf: () => Pending): Promise<void> {
    const take = await this.replica(true);
    const before = this.contentNow();
    const fields = [...this.fieldWatchers].map((watcher) => [watcher, watcher.last?.toString()] as const);
    const pending = pendingOf();
    this.swapping = true;
    try {
      this.teardownProvider();
      take();
      this.captureConfirmed();
      this.replay(pending);
    } finally {
      this.swapping = false;
    }
    for (const handler of this.swapHandlers) handler();
    this.emitReplacement(before, fields);
  }

  /** One change event describing a replica swap, as a single replacement where text is concerned; none if nothing changed. */
  private emitReplacement(before: string, fields: readonly (readonly [FieldWatcher, string | undefined])[]): void {
    for (const [watcher, was] of fields) {
      if (!this.fieldWatchers.has(watcher)) continue;
      const now = this.lookup(watcher.path);
      watcher.last = now instanceof Y.Text ? now : undefined;
      // Its text differs on the new replica: the handle hears it, without a delta (read it again).
      if (watcher.last?.toString() !== was) watcher.handler({ local: false });
    }
    const after = this.contentNow();
    if (after === before) return;
    if (this.type === 'text') {
      const change = diffOnce(before, after)!;
      const delta: TextDelta = [];
      if (change.at) delta.push({ retain: change.at });
      if (change.removed) delta.push({ delete: change.removed.length });
      if (change.inserted) delta.push({ insert: change.inserted });
      this.emitChange({ local: false, delta });
    } else {
      this.emitChange({ local: false });
    }
  }

  private emitRefused(reason: RefusedReason): void {
    for (const handler of [...this.refusedHandlers]) handler({ reason });
  }

  /**
   * The file moved to a new epoch under us. Take what we had that the open file never confirmed,
   * open the new copy, and replay it there the way an agent would: one `edit(old, new)` with
   * enough context to be unique (真源 §2.2「重放」).
   */
  private async reopenAtNewEpoch(pendingOf: () => Pending = () => this.pendingSinceConfirmed()): Promise<void> {
    this.reopening = true;
    try {
      const opened = await this.host.appFiles.reopen({ ref: { ...placeOfFile(this.entry), id: this.entry.id }, ...(this.readOnly ? { readOnly: true } : {}) });
      this.entry = opened.entry;
      this.docName = opened.docName;
      await this.swapReplica(pendingOf);
    } catch (error) {
      // Let go of meanwhile, and no new replica to put what it wrote back on: said, never dropped without a word.
      if (this.closeAfterSwap && pendingOf()) {
        const why = error instanceof Error ? error.message : String(error);
        this.warn(`let go of while it reopened at a new epoch, and the reopen failed (${why}): what was written since is not kept`);
      }
      throw error;
    } finally {
      this.reopening = false;
      // Let go of while it reopened (`close`): now it closes — the replayed writes go out with the new replica, and a
      // will holds them too (L3's review, probe I).
      if (this.closeAfterSwap) {
        this.closeAfterSwap = false;
        this.close(true);
      }
    }
  }

  private pendingSinceConfirmed(): Pending {
    if (this.readOnly || !this.provider.hasUnsyncedChanges || !this.confirmed) return null;
    return this.pendingSince('text' in this.confirmed ? this.confirmed.text : this.confirmed.json);
  }

  /** What this page has now that `base` (the file as the service holds it, or will) lacks: one replacement, or the keys. */
  private pendingSince(base: string | Record<string, unknown>): Pending {
    if (typeof base === 'string') {
      const now = this.doc.getText('content').toString();
      const change = diffOnce(base, now);
      if (!change) return null;
      return {
        text: change,
        context: [base.slice(Math.max(0, change.at - 32), change.at), base.slice(change.at + change.removed.length, change.at + change.removed.length + 32)],
      };
    }
    const now = this.doc.getMap('root').toJSON() as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(now), ...Object.keys(base)]);
    for (const key of keys) {
      if (canonical(now[key]) !== canonical(base[key])) changed[key] = now[key];
    }
    return Object.keys(changed).length ? { json: changed } : null;
  }

  // ─── compacted while open (摩擦单 F71) ───────────────────────────────────

  /**
   * The file service's stateless word: `self` (who this page is), and a hot compaction's `compact` (drain: send what is
   * batched, pause, answer `drained` once all of it is confirmed) and `resume` (given up: send as before).
   */
  private fromService(payload: string): void {
    let message: { t?: unknown } | null;
    try {
      message = JSON.parse(payload) as { t?: unknown } | null;
    } catch {
      return;
    }
    if (message?.t === 'self') this.selfFromService(message as Parameters<OpenFile['selfFromService']>[0]);
    else if (message?.t === 'compact') this.startCompaction();
    else if (message?.t === 'resume') this.endCompaction();
  }

  private startCompaction(): void {
    if (this.compaction || this.closed || this.status === 'gone' || this.reopening) return;
    const provider = this.provider;
    const replica = provider.document;
    // Paused: this page's changes wait in the provider's own batch — held, not sent, until `resume` or the swap (a timer
    // that never fires: the longest one there is). Nothing was batched before: the provider sends each change at once.
    provider.configuration.flushDelay = HELD_MS;
    const shadow = new Y.Doc();
    Y.applyUpdate(shadow, Y.encodeStateAsUpdate(replica));
    const follow = (update: Uint8Array, origin: unknown) => {
      if (origin === provider) Y.applyUpdate(shadow, update);
      else if (this.compaction) this.compaction.held = true;
    };
    replica.on('update', follow);
    const check = () => this.drainedCheck();
    provider.on('unsyncedChanges', check);
    const offReleased = syncLink().onReleased(this.docName, check);
    this.compaction = {
      shadow,
      drained: false,
      held: false,
      stop: () => {
        replica.off('update', follow);
        provider.off('unsyncedChanges', check);
        offReleased();
        shadow.destroy();
      },
    };
    this.drainedCheck();
  }

  /**
   * `drained` once — when every frame this page sent is confirmed and nobody is composing on it (L3 #2: a swap under an
   * input method would break the word; the service gives up after its drain window and tries again later). Checked on
   * each confirmation and each hold's end: no timers (L3 #4).
   */
  private drainedCheck(): void {
    const compaction = this.compaction;
    if (!compaction || compaction.drained) return;
    // What was sent and not yet confirmed: the provider counts a held batch as one the moment it starts.
    const unconfirmed = this.provider.unsyncedChanges - (compaction.held ? 1 : 0);
    if (unconfirmed > 0 || syncLink().isHeld(this.docName)) return;
    compaction.drained = true;
    this.provider.sendStateless(JSON.stringify({ t: 'drained' }));
  }

  /** The pause is over — resumed, reopened, or its connection gone: the shadow goes and this page sends as before. */
  private endCompaction(): void {
    const compaction = this.compaction;
    if (!compaction) return;
    this.compaction = null;
    compaction.stop();
    // Sent as before: every change at once, what was held first.
    this.provider.configuration.flushDelay = false;
    this.provider.flushPendingUpdates();
    this.progressed();
  }

  /**
   * Closed at the new epoch (`compacted:<n>`), or a frame refused mid-swap (`compacting`): reopen there and replay what
   * this page wrote since it paused — shadow → now, so nothing of anyone else's is written twice. Without a pause (a
   * frame that raced the swap), what the service never confirmed, as after a cold compaction.
   */
  private async reopenAfterCompaction(): Promise<void> {
    if (this.reopening) return;
    // The pause is over (the old connection is closed); the shadow stays until the new replica is taken.
    const compaction = this.compaction;
    this.compaction = null;
    const pendingOf = (): Pending => {
      // A read-only page wrote nothing.
      if (this.readOnly) return null;
      if (!compaction) return this.pendingSinceConfirmed();
      const shadow = compaction.shadow;
      return this.pendingSince(this.type === 'text' ? shadow.getText('content').toString() : (shadow.getMap('root').toJSON() as Record<string, unknown>));
    };
    try {
      await this.reopenAtNewEpoch(pendingOf);
    } catch (error) {
      if (this.status === 'gone' || this.closed) return;
      this.warn(`could not reopen after the file service compacted it (${error instanceof Error ? error.message : String(error)}); connecting again`);
      await this.documentClosed('reopen-failed');
    } finally {
      compaction?.stop();
      this.progressed();
    }
  }

  private replay(pending: ReturnType<OpenFile['pendingSinceConfirmed']>): void {
    if (!pending) return;
    if ('json' in pending) {
      const root = this.doc.getMap('root');
      this.doc.transact(() => {
        for (const [key, value] of Object.entries(pending.json)) {
          if (value === undefined) root.delete(key);
          else mergeValue(root, key, value);
        }
      });
      return;
    }
    const change = pending.text;
    if (!change) return;
    const text = this.doc.getText('content');
    const current = text.toString();
    const [before, after] = pending.context;
    const needle = before + change.removed + after;
    const first = current.indexOf(needle);
    // Written into an empty file, the needle is empty: that is one place only in an empty text (`indexOf('', 1)` still finds one).
    const unique = needle === '' ? current === '' : first >= 0 && current.indexOf(needle, first + 1) < 0;
    if (!unique) {
      void this.host.reportError(`gugu: an unsaved change to ${this.entry.name} could not be replayed after the file was compacted`);
      return;
    }
    const at = first + before.length;
    this.doc.transact(() => {
      if (change.removed) text.delete(at, change.removed.length);
      if (change.inserted) text.insert(at, change.inserted);
    });
  }

  private teardownProvider(): void {
    this.detachDoc?.();
    this.detachDoc = null;
    this.destroyProvider();
    this.doc.destroy();
  }

  /** Once per provider: a second destroy would send a second Close and destroy awareness twice. */
  private destroyProvider(): void {
    if (this.destroyedProvider === this.provider) return;
    this.destroyedProvider = this.provider;
    this.provider.destroy();
  }

  /**
   * Taken back by main, or refused by main or the file service for good — said to an open still waiting as `why`.
   * Deleted (`reason`), it may come back: a task's file put back on the disk (main says `back`, see `cameBack`).
   */
  gone(why?: Error, reason?: SyncRevokeReason): void {
    // Said twice for one deletion — the service's Close (`deleted`), then main's `revoked` — in either order.
    if (reason === 'deleted' && !this.closed) returning.set(this.docName, this);
    if (this.status === 'gone') return;
    this.connecting?.reject(why ?? guguError('failed', `${this.entry.name} is no longer available`));
    this.setStatus('gone');
    for (const timer of [this.willTimer, this.retryTimer, this.stallTimer]) if (timer) clearTimeout(timer);
    // Let go of too: a file that comes back (F92) arms them again, and a cleared handle left here would stop it for good.
    this.willTimer = this.retryTimer = this.stallTimer = null;
    this.compaction?.stop();
    this.compaction = null;
    if (this.provider) this.destroyProvider();
    this.stopSyncing();
  }

  /**
   * 摩擦单 F92: its file is on the disk again (a task's working copy — `git checkout -- f`, an undo). Opened again under
   * the next generation, built from the disk, and `online`: the App hears `onStatus('online')` and one `onChange`, and a
   * binding re-attaches (`onSwap`). Nothing of the old replica is replayed — the file as it came back is what holds.
   */
  async cameBack(): Promise<void> {
    if (returning.get(this.docName) === this) returning.delete(this.docName);
    if (this.closed || this.status !== 'gone') return;
    // Opened again meanwhile (the App's own `files.open(…)` once it was there): that replica is the file on this page now.
    const current = openFiles.get(fileKey(this.entry));
    if (current && current !== this && current.status !== 'gone') return;
    let opened: AppFileOpened;
    try {
      opened = await this.host.appFiles.reopen({ ref: { ...placeOfFile(this.entry), id: this.entry.id }, ...(this.readOnly ? { readOnly: true } : {}) });
    } catch (error) {
      // Gone again already, or not to be opened any more: it stays gone.
      this.warn(`is back on the disk but could not be opened again (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (this.closed) {
      void this.host.appFiles.close({ docName: opened.docName }).catch(() => undefined);
      return;
    }
    // What the App read before, as a swap takes it (`emitReplacement`): the whole content, and each `textAt` field's text.
    const before = this.contentNow();
    const fields = [...this.fieldWatchers].map((watcher) => [watcher, watcher.last?.toString()] as const);
    // Its own teardown and connect, not `swapReplica`: nothing of the gone replica is replayed onto the one from the disk.
    this.teardownProvider();
    this.entry = opened.entry;
    this.docName = opened.docName;
    // The one way out of `gone`: from here it is a file opening, and online once it has synced.
    this.status = 'offline';
    this.stallSaid = false;
    // Filling the new replica is not a change the App sees, as in a swap: one change below says what really changed. Only
    // the service's transactions: what the App writes meanwhile is its own, heard and kept as ever (`filling`).
    this.filling = true;
    try {
      await this.connect();
    } catch {
      // Refused (deleted again at once) or closed while connecting: gone, as `connect` left it.
      this.gone();
      return;
    } finally {
      this.filling = false;
    }
    openFiles.set(fileKey(this.entry), this);
    for (const handler of this.swapHandlers) handler();
    this.emitReplacement(before, fields);
  }

  /**
   * Main dropped a frame of this file's. `read-only`: a change this page may not make. Anything else
   * (`not-granted`, `key-in-use`): main does not let this page speak for the file at all — it cannot
   * sync, so it must not go on reading `online` (摩擦单 F46).
   */
  refused(reason: string): void {
    // Stopped already: a refusal of its last frames (a Close after a revocation) says nothing new.
    if (this.status === 'gone' || this.closed) return;
    if (reason === 'read-only') {
      void this.host.reportError(`gugu: a change to ${this.entry.name} was refused (${reason})`);
      return;
    }
    const message = `${this.entry.name} cannot sync: main refused its traffic (${reason})`;
    void this.host.reportError(`gugu: ${message}`);
    this.gone(guguError('file-unavailable', message));
  }

  /** Something about this file the App's author should hear (its error record, `app_check` reads it back). */
  warn(message: string, level: 'error' | 'hint' = 'error'): void {
    void this.host.reportError(`gugu: ${this.entry.name}: ${message}`, level === 'hint' ? { level } : undefined);
  }
  /** Every handle let go (or the open never finished): the provider goes and main is told. */
  close(willEvenOnline = false): void {
    if (this.closed) return;
    // Mid-reopen at a new epoch: what this page wrote since it paused is only put back once the new replica is taken —
    // closing now would drop it without a word. The file closes when the swap is done (`reopenAtNewEpoch`).
    if (this.reopening) {
      this.closeAfterSwap = true;
      return;
    }
    this.closed = true;
    if (openFiles.get(fileKey(this.entry)) === this) openFiles.delete(fileKey(this.entry));
    if (returning.get(this.docName) === this) returning.delete(this.docName);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.provider) {
      // Closed while paused for a compaction (摩擦单 F71): what was kept goes now — a draining service still takes it —
      // and into a will too, in case the swap got there first (a will at the old epoch is refused out loud, never lost quietly).
      const paused = this.compaction !== null;
      this.endCompaction();
      this.flushWill(paused || willEvenOnline);
      this.detachDoc?.();
      this.destroyProvider();
    }
    this.stopSyncing();
    void this.host.appFiles.close({ docName: this.docName }).catch(() => undefined);
  }

  /** The page's socket rests once none of its files is syncing: an empty one kept main's connection spinning (摩擦单 F46). */
  private stopSyncing(): void {
    syncing.delete(this);
    if (syncing.size === 0) restPageSocket();
  }

  // ─── status, saving, the will ─────────────────────────────────────────────

  /** What `saved` said when `onStatus` last fired: it fires when `saved` moves too (摩擦单 F20 — it turned true silently). */
  private lastSaved = true;

  private setStatus(next: FileStatus): void {
    if (this.status === 'gone' || this.status === next) return;
    this.status = next;
    this.lastSaved = this.saved;
    if (next === 'online') this.unsyncedMoved();
    for (const handler of this.statusHandlers) handler(next);
  }

  private unsyncedMoved(): void {
    const saved = this.saved;
    if (saved !== this.lastSaved) {
      this.lastSaved = saved;
      for (const handler of this.statusHandlers) handler(this.status);
    }
    if (this.saved && this.status === 'online') {
      this.captureConfirmed();
      if (this.willPosted) {
        syncLink().post({ t: 'will', docName: this.willPosted, update: null });
        this.willPosted = null;
      }
    } else if (this.status !== 'online') {
      this.scheduleWill();
    }
  }

  private localChanged(): void {
    countsOf(this.host)?.wrote();
    if (this.status !== 'online') this.scheduleWill();
  }

  /**
   * 摩擦单 F62 / F84: one position of a JSON file written frame after frame — a clock, a stroke being drawn — is state that
   * belongs in presence, whoever is at the keys or the pointer (S19: a person drawing kept the page's user activation on,
   * and the old "nobody typing" gate hid exactly that stroke). A position is `path.key` for a map, `path` for an array
   * (an array assigned merges into the one there, so a stroke rewritten each frame lands as inserts on it), counted once
   * per transaction however many events it made there; typing (Y.Text: text files, `$text` fields) is what text is for
   * and never counts. Not covered: an App that replaces a whole text file every frame.
   */
  private countWrites(events: readonly Y.YEvent<Y.AbstractType<unknown>>[]): void {
    if (this.busySaid) return;
    const positions = new Set<string>();
    for (const event of events) {
      if (event.target instanceof Y.Text) continue;
      const path = event.path.map(String);
      if (event.target instanceof Y.Map) {
        for (const key of (event as Y.YMapEvent<unknown>).keysChanged) positions.add([...path, key].join('.'));
      }
      else positions.add(path.join('.'));
    }
    if (positions.size === 0) return;
    const second = Math.floor(Date.now() / 1000);
    if (second !== this.writesSecond) {
      const gap = Math.min(second - this.writesSecond, BUSY_SECONDS);
      for (const [position, counts] of this.writesAt) {
        for (let i = 0; i < gap; i += 1) counts.push(0);
        counts.splice(0, counts.length - BUSY_SECONDS);
        if (counts.every((writes) => writes === 0)) this.writesAt.delete(position);
      }
      this.writesSecond = second;
    }
    for (const position of positions) {
      const counts = this.writesAt.get(position) ?? [0];
      this.writesAt.set(position, counts);
      counts[counts.length - 1] = (counts[counts.length - 1] ?? 0) + 1;
      if (counts.length === BUSY_SECONDS && counts.every((writes) => writes > BUSY_WRITES_PER_SECOND)) {
        this.busySaid = true;
        const rate = Math.round((counts.reduce((sum, writes) => sum + writes, 0) / BUSY_SECONDS) * 10) / 10;
        const where = position ? `\`${position}\`` : 'the file';
        this.warn(
          `${where} written ${rate} times a second: keep what changes every frame in f.presence and write only events to the file; text people type goes in gugu.text('')`,
          'hint'
        );
        return;
      }
    }
  }

  private captureConfirmed(): void {
    if (this.provider.hasUnsyncedChanges) return;
    this.confirmed =
      this.type === 'text'
        ? { text: this.doc.getText('content').toString() }
        : { json: this.doc.getMap('root').toJSON() as Record<string, unknown> };
  }

  /**
   * Offline with changes the open file has not confirmed: keep main holding a copy, so closing
   * the page now does not lose them (main delivers it when the connection is back).
   */
  private scheduleWill(): void {
    if (this.readOnly || this.status === 'gone' || this.willTimer) return;
    this.willTimer = setTimeout(() => {
      this.willTimer = null;
      this.flushWill();
    }, WILL_DELAY_MS);
  }

  flushWill(evenOnline = false): void {
    if (this.willTimer) {
      clearTimeout(this.willTimer);
      this.willTimer = null;
    }
    if (this.readOnly || (this.status === 'online' && !evenOnline) || !this.provider.hasUnsyncedChanges) return;
    // Under the replica's own document. Mid-reopen `docName` already names the new epoch (main's grant and control words
    // follow it): this replica's whole state delivered there would write the file's content a second time.
    const docName = this.provider.configuration.name;
    const update = Y.encodeStateAsUpdate(this.doc);
    syncLink().post({ t: 'will', docName, update: update.slice().buffer });
    this.willPosted = docName;
  }

  // ─── change events ────────────────────────────────────────────────────────

  private emitChange(event: { local: boolean; delta?: TextDelta }): void {
    for (const handler of [...this.changeHandlers]) handler(event);
  }

  /** `textAt` handles: their field's letters changed (`delta`), or the field itself went or was replaced (no delta). */
  private emitFieldChanges(events: Y.YEvent<Y.AbstractType<unknown>>[], local: boolean): void {
    for (const watcher of [...this.fieldWatchers]) {
      const now = this.lookup(watcher.path);
      const text = now instanceof Y.Text ? now : undefined;
      if (text !== watcher.last) {
        watcher.last = text;
        watcher.handler({ local });
        continue;
      }
      const event = text ? events.find((candidate) => candidate.target === text) : undefined;
      if (event) watcher.handler({ local, delta: event.delta as TextDelta });
    }
  }

  onSwap(handler: () => void): () => void {
    this.swapHandlers.add(handler);
    return () => this.swapHandlers.delete(handler);
  }

  // ─── presence ─────────────────────────────────────────────────────────────

  /**
   * Our awareness state is `{ user, s }`: `s` is what the App set; `user` is filled by the
   * file service from the connection's identity (真源 §2.4 评审第 3 条) — ours is only a
   * placeholder until the service overwrites it.
   */
  private publishPresence(awareness = this.provider.awareness): void {
    // A program's copy is on nobody's screen: it says nothing about who is here (F16).
    if (this.host.program) return;
    if (!awareness) return;
    // Sent at once; over its presence rate the file service passes on the latest and drops the ones between (F38).
    // One state, one frame. Setting the two fields one by one sent two awareness updates for every set — twice
    // what the file service's per-connection presence limit counts, and a frame the others apply for nothing (摩擦单 F38).
    const state = awareness.getLocalState();
    if (state === null) return;
    awareness.setLocalState({ ...state, user: { id: this.self.userId, name: this.self.name, color: this.self.color }, s: this.presenceState });
  }

  /**
   * The file service's `{ t: 'self', user: { id, name, color } }` (stateless, after Auth): this page's
   * identity in presence from then on.
   */
  private selfFromService(message: { user?: { id?: unknown; name?: unknown; color?: unknown } }): void {
    const user = message.user;
    if (!user || typeof user.id !== 'string' || typeof user.color !== 'string') return;
    this.self.userId = personId(user.id);
    if (typeof user.name === 'string') this.self.name = user.name;
    this.self.color = user.color;
    this.publishPresence();
    this.emitPresence();
  }

  others(): Peer[] {
    const awareness = this.provider.awareness;
    if (!awareness) return [];
    const peers: Peer[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === this.doc.clientID || !state) continue;
      const user = (state as { user?: { id?: unknown; name?: unknown; color?: unknown } }).user ?? {};
      const userId = typeof user.id === 'string' ? personId(user.id) : '';
      peers.push({
        id: String(clientId),
        userId,
        name: typeof user.name === 'string' ? user.name : '',
        color: typeof user.color === 'string' ? user.color : '',
        state: (state as { s?: unknown }).s ?? null,
      });
    }
    return peers;
  }

  private emitPresence(): void {
    if (this.presenceHandlers.size === 0) return;
    const peers = this.others();
    for (const handler of [...this.presenceHandlers]) handler(peers);
  }

  // ─── the public objects ───────────────────────────────────────────────────

  /** A closed handle does nothing more: it says so rather than act on a file it let go. */
  private live(handle: Handle): void {
    if (handle.closed) throw guguError('failed', `${this.entry.name} was closed here; open it again with gugu.files.open(…)`);
  }

  /** A handler registered through `handle`, unregistered when the handle is closed. */
  private subscribe<T>(handle: Handle, handlers: Set<T>, handler: T): () => boolean {
    this.live(handle);
    handlers.add(handler);
    const off = () => {
      handle.off.delete(off);
      return handlers.delete(handler);
    };
    handle.off.add(off);
    return off;
  }

  private base(handle: Handle): Record<string, unknown> {
    const presence = Object.freeze(
      liveObject({
        self: { get: () => ({ ...this.self, state: this.presenceState }) },
        others: { get: () => this.others() },
        set: {
          value: (state: unknown) => {
            this.live(handle);
            if (state !== null && state !== undefined) JSON.stringify(state);
            this.presenceState = state ?? null;
            countsOf(this.host)?.setPresence();
            this.publishPresence();
          },
        },
        onChange: {
          value: (handler: (others: readonly Peer[]) => void) => this.subscribe(handle, this.presenceHandlers, handler),
        },
      }),
    );
    return liveObject({
      entry: { get: () => ({ ...this.entry }) },
      readOnly: { get: () => this.readOnly },
      // A closed handle reads `gone`; the file's other handles carry on.
      status: { get: () => (handle.closed ? 'gone' : this.status) },
      saved: { get: () => this.saved },
      onChange: {
        value: (handler: (event: { local: boolean; delta?: TextDelta }) => void) => this.subscribe(handle, this.changeHandlers, handler),
      },
      onStatus: {
        value: (handler: (status: FileStatus) => void) => this.subscribe(handle, this.statusHandlers, handler),
      },
      /**
       * The open file refused what this page sent: `too-large` (the change was taken back — an
       * `onChange` follows with the content as the open file has it) or `rate-limited` (it is
       * retried after a pause; `status` reads `offline` meanwhile).
       */
      onRefused: {
        value: (handler: (event: { reason: RefusedReason }) => void) => this.subscribe(handle, this.refusedHandlers, handler),
      },
      presence: { value: presence },
      close: { value: () => this.release(handle) },
    });
  }

  private writable(handle: Handle): void {
    this.live(handle);
    if (this.readOnly) throw guguError('read-only', `${this.entry.name} is open read-only`);
    if (this.status === 'gone') throw guguError('failed', `${this.entry.name} is no longer available`);
  }

  /** A text file's text. */
  content(): Y.Text {
    return this.doc.getText('content');
  }

  private makeTextFile(handle: Handle): object {
    return Object.freeze(
      Object.defineProperties(this.base(handle), {
        type: { value: 'text', enumerable: true },
        ...this.textVerbs(handle, () => this.content()),
      }),
    );
  }

  /** What stands at `path` in a JSON file now: a field's value as stored (a Y.Text for collaborative text). */
  lookup(path: readonly (string | number)[]): unknown {
    let at: unknown = this.doc.getMap('root');
    for (const key of path) {
      if (at instanceof Y.Map && typeof key === 'string') at = at.get(key);
      else if (at instanceof Y.Array && typeof key === 'number' && key < at.length) at = at.get(key);
      else return undefined;
    }
    return at;
  }

  /**
   * `f.textAt(path)` (摩擦单 F8): a collaborative text field of this JSON file as a text handle — the verbs of a text
   * file, and bindable (`gugu.bind.text`, `gugu.bind.codemirror`). It follows the field as long as it is collaborative
   * text; deleted, or replaced by another value, it reads `gone`.
   */
  private fieldHandle(handle: Handle, path: readonly (string | number)[]): object {
    const named = path.map((key) => (typeof key === 'number' ? `[${key}]` : `.${key}`)).join('').replace(/^\./, '');
    const field = () => {
      const text = this.lookup(path);
      if (!(text instanceof Y.Text)) throw guguError('failed', `${named} is no longer collaborative text (deleted, or replaced by another value)`);
      return text;
    };
    const handleObject = Object.freeze(
      Object.defineProperties(
        liveObject({
          path: { value: Object.freeze([...path]) },
          readOnly: { get: () => this.readOnly },
          status: { get: () => (handle.closed || !(this.lookup(path) instanceof Y.Text) ? 'gone' : this.status) },
          saved: { get: () => this.saved },
          /** This field's changes (`delta` for letters), and one without `delta` when the field itself went. */
          onChange: {
            value: (handler: (event: { local: boolean; delta?: TextDelta }) => void) =>
              this.subscribe<FieldWatcher>(handle, this.fieldWatchers, {
              path,
              last: this.lookup(path) instanceof Y.Text ? (this.lookup(path) as Y.Text) : undefined,
              handler,
            }),
          },
          onStatus: {
            value: (handler: (status: FileStatus) => void) => this.subscribe(handle, this.statusHandlers, handler),
          },
        }),
        { type: { value: 'text', enumerable: true }, ...this.textVerbs(handle, field) },
      ),
    );
    internals.set(handleObject, new FieldText(this, path, field));
    return handleObject;
  }

  /** The verbs of a text handle — a text file's, and a JSON file's text field's (`textAt`). */
  private textVerbs(handle: Handle, text: () => Y.Text): PropertyDescriptorMap {
    const inRange = (value: number, max: number, what: string) => {
      if (!Number.isInteger(value) || value < 0 || value > max) {
        throw guguError('invalid', `${what} ${value} is outside 0…${max}`);
      }
    };
    return {
        text: { get: () => text().toString(), enumerable: true },
        length: { get: () => text().length, enumerable: true },
        insert: {
          value: (index: number, value: string) => {
            this.writable(handle);
            inRange(index, text().length, 'index');
            if (typeof value !== 'string') throw guguError('invalid', 'insert takes a string');
            if (value) text().insert(index, value);
          },
        },
        delete: {
          value: (index: number, length: number) => {
            this.writable(handle);
            inRange(index, text().length, 'index');
            inRange(length, text().length - index, 'length');
            if (length) text().delete(index, length);
          },
        },
        edit: {
          value: (old: string, next: string) => {
            this.writable(handle);
            if (typeof old !== 'string' || !old) throw guguError('invalid', 'edit needs a non-empty old string');
            if (typeof next !== 'string') throw guguError('invalid', 'edit takes a string to put in');
            const current = text().toString();
            const at = current.indexOf(old);
            if (at < 0) throw guguError('content-changed', 'old is not in the file (it changed, or it does not match exactly)', { reason: 'old-not-found' });
            if (current.indexOf(old, at + 1) >= 0) throw guguError('ambiguous', 'old matches more than once; include more context', { reason: 'old-matches-many' });
            this.doc.transact(() => {
              text().delete(at, old.length);
              text().insert(at, next);
            });
          },
        },
        /**
         * What the text is now, to rewrite from (摩擦单 F59): an editor that turns its whole view back into text
         * passes this and its new text to `applyFrom`, never a diff against `f.text` — which by then may hold
         * letters others typed meanwhile, and a diff against it would delete them.
         */
        snapshot: {
          value: () => {
            this.live(handle);
            const taken = Object.freeze({ text: text().toString() });
            snapshots.set(taken, { doc: this.doc, snapshot: Y.snapshot(this.doc) });
            return taken;
          },
        },
        /** Lands `snapshot.text → next` on the text as it is now: others' letters since then stay, the unchanged is not touched. */
        applyFrom: {
          value: (taken: { text: string }, next: string) => {
            this.writable(handle);
            const from = taken && typeof taken === 'object' ? snapshots.get(taken) : undefined;
            if (!from) throw guguError('invalid', 'applyFrom takes what f.snapshot() returned, and the new text');
            if (typeof next !== 'string') throw guguError('invalid', 'applyFrom takes the new text as a string');
            // Another file's, or this one before it was reloaded (compacted): its letters are not here to map.
            if (from.doc !== this.doc) throw guguError('content-changed', `${this.entry.name} was reloaded since that snapshot; take a new one`);
            applyFromSnapshot(text(), from.snapshot, taken.text, next);
          },
        },
        anchor: {
          value: (index: number, assoc: -1 | 1 = 1) => {
            inRange(index, text().length, 'index');
            const position = Y.createRelativePositionFromTypeIndex(text(), index, assoc < 0 ? -1 : 0);
            return `${this.epoch}:${toBase64(Y.encodeRelativePosition(position))}`;
          },
        },
        resolve: {
          value: (anchor: string) => {
            if (typeof anchor !== 'string') return null;
            const at = anchor.indexOf(':');
            if (at < 0 || anchor.slice(0, at) !== this.epoch) return null;
            try {
              const position = Y.decodeRelativePosition(fromBase64(anchor.slice(at + 1)));
              const absolute = Y.createAbsolutePositionFromRelativePosition(position, this.doc);
              return absolute && absolute.type === text() ? absolute.index : null;
            } catch {
              return null;
            }
          },
        },
    };
  }

  private makeJsonFile(handle: Handle): object {
    // Throws the reason it may not be written (read-only, gone, or this handle closed); one per handle.
    const writable = () => {
      this.writable(handle);
      return true;
    };
    // One `f.data` for the handle's life (摩擦单 F71): it reads and writes the replica there is now, compacted or not.
    let root: { doc: Y.Doc; proxy: Record<string, unknown> } | null = null;
    const current = () => {
      if (root?.doc !== this.doc) root = { doc: this.doc, proxy: mapProxy(this.doc.getMap('root'), writable) };
      return root.proxy;
    };
    const data = new Proxy(Object.create(null) as Record<string | symbol, unknown>, {
      get: (_target, key) => Reflect.get(current(), key),
      set: (_target, key, value) => Reflect.set(current(), key, value),
      deleteProperty: (_target, key) => Reflect.deleteProperty(current(), key),
      has: (_target, key) => Reflect.has(current(), key),
      ownKeys: () => Reflect.ownKeys(current()),
      getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(current(), key),
      defineProperty: (_target, key, descriptor) => Reflect.defineProperty(current(), key, descriptor),
    });
    return Object.freeze(
      Object.defineProperties(this.base(handle), {
        type: { value: 'json', enumerable: true },
        data: { get: () => data, enumerable: true },
        transact: {
          value: (fn: () => void) => {
            this.writable(handle);
            this.doc.transact(fn);
          },
        },
        toJSON: { value: () => this.doc.getMap('root').toJSON() },
        /**
         * A3 The file as text, as an agent reads it (two-space indented), and `edit(old, new)` on it — the file service's own
         * edit (`@gugu/files-core`), so an App's tool edits a JSON file exactly as an agent does (原则 4); the result, still
         * an object, goes in key by key, so text people type in stays theirs.
         */
        text: { get: () => readText(this.doc, JSON_CONTENT_TYPE, { pretty: true }), enumerable: true },
        edit: {
          value: (old: string, next: string) => {
            this.writable(handle);
            if (typeof old !== 'string' || !old) throw guguError('invalid', 'edit needs a non-empty old string');
            if (typeof next !== 'string') throw guguError('invalid', 'edit takes a string to put in');
            const { status, body } = applyEdit(this.doc, JSON_CONTENT_TYPE, old, next, WORKSPACE_TEXT_MAX_BYTES);
            if (status !== 200) throw jsonEditRefusal(body as { error?: string; message?: string });
          },
        },
        textAt: {
          value: (path: unknown) => {
            this.live(handle);
            if (!Array.isArray(path) || path.length === 0 || !path.every((key) => typeof key === 'string' || (Number.isInteger(key) && key >= 0))) {
              throw guguError('invalid', "textAt takes the field's path as an array of keys and indexes, e.g. ['slides', id, 'body']");
            }
            const value = this.lookup(path);
            if (value instanceof Y.Text) return this.fieldHandle(handle, path as (string | number)[]);
            if (typeof value === 'string') {
              throw guguError('invalid', `${path.join('.')} is a plain string: make it collaborative text when you create it — gugu.text(...)`);
            }
            throw guguError('invalid', `${path.join('.')} is not collaborative text${value === undefined ? ' (there is nothing there)' : ''}`);
          },
        },
      }),
    );
  }

  internalsForBinding(text: () => Y.Text = () => this.content()): FileInternals {
    return liveObject({
      doc: { get: () => this.doc },
      text: { get: () => text() },
      awareness: { get: () => this.provider.awareness! },
      readOnly: { value: this.readOnly },
      onSwap: { value: (handler: () => void) => this.onSwap(handler) },
      holdRemote: { value: () => syncLink().hold(this.docName) },
      inspectRemote: {
        value: (inspector: (update: Uint8Array) => void) =>
          syncLink().inspect(this.docName, inspector, (error) => {
            void this.host.reportError(`gugu: ${this.entry.name}: the same-line hold stopped (${error instanceof Error ? error.message : String(error)}); remote changes land as usual`);
          }),
      },
      keyboardSession: { value: this.host.framed === true },
    }) as unknown as FileInternals;
  }
}

/**
 * An object whose properties read through to the file behind it — `get` for facts that change
 * (content, status), `value` for verbs. Built from arrow functions, so the file is reached
 * without aliasing `this`.
 */
function liveObject(props: Record<string, { get: () => unknown } | { value: unknown }>): Record<string, unknown> {
  return Object.defineProperties(
    {},
    Object.fromEntries(Object.entries(props).map(([key, descriptor]) => [key, { ...descriptor, enumerable: true }])),
  ) as Record<string, unknown>;
}

/**
 * A JSON file's collaborative text field as the bindings see it (`gugu.bind.text`, `gugu.bind.codemirror` on
 * `f.textAt(path)`): the same as a text file, with the field's Y.Text — looked up again each time, so a replica swapped
 * after a compaction is followed.
 */
export class FieldText {
  readonly type = 'text' as const;
  constructor(
    private readonly file: OpenFile,
    readonly path: readonly (string | number)[],
    private readonly field: () => Y.Text,
  ) {}

  get doc(): Y.Doc {
    return this.file.doc;
  }

  content(): Y.Text {
    return this.field();
  }

  internalsForBinding(): FileInternals {
    return this.file.internalsForBinding(this.field);
  }

  warn(message: string, level: 'error' | 'hint' = 'error'): void {
    this.file.warn(message, level);
  }

  onSwap(handler: () => void): () => void {
    return this.file.onSwap(handler);
  }
}

/** `f.snapshot()`'s answers → the replica and the Yjs snapshot taken with them (opaque to the App). */
const snapshots = new WeakMap<object, { doc: Y.Doc; snapshot: Y.Snapshot }>();

/**
 * One replica per file per page: opening the same file again is another handle on it (摩擦单 F46). Keyed by where it lives
 * and its id there (`fileKey`): a path is only unique in its session, and a page may hold two sessions' files.
 */
export const openFiles = new Map<string, OpenFile>();

/** What a file is kept under on this page: its place and its id there. */
export function fileKey(entry: Pick<AppFileEntry, 'id' | 'chat' | 'session'>): string {
  return `${placeKey(placeOfFile(entry))}#${entry.id}`;
}

/**
 * `files.open` calls main has not answered yet: any of them may be a file already open here, and takes a handle on it
 * when it answers. A replica whose last handle goes meanwhile waits for them — closed now, main would let go of the
 * grant it has just made for that open, and the new replica is refused (摩擦单 F115).
 */
let unanswered = 0;
const whenAnswered: (() => void)[] = [];

/** One more open on its way to main; call what comes back once its answer has taken its handle (or failed). */
export function askingMain(): () => void {
  unanswered += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    unanswered -= 1;
    if (unanswered === 0) for (const run of whenAnswered.splice(0)) run();
  };
}

/** The files whose providers are on the page's socket (or on their way to it). */
const syncing = new Set<OpenFile>();

/** Files gone as deleted, by the open file they went from: main says `back` when a task's file is on the disk again. */
const returning = new Map<string, OpenFile>();

/**
 * An open file taken back by main: the file stops (`status: 'gone'`). A frame main dropped is said
 * out loud (`refused`). Files still opening hear it too: their `open()` ends with the reason. A task's file deleted
 * and put back comes back (`back`).
 */
syncLink().onControl((message) => {
  if (message.t === 'back') {
    void returning.get(message.docName)?.cameBack();
    return;
  }
  for (const file of [...syncing]) {
    if (message.t === 'revoked' && file.docName === message.docName) {
      file.gone(guguError('failed', `${file.entry.name} was taken back (${message.reason})`), message.reason);
    }
    if (message.t === 'denied' && message.key.startsWith(`${file.docName}\u0000`)) file.refused(message.reason);
  }
});

// Offline changes must reach main before the page is gone.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const file of openFiles.values()) file.flushWill();
  });
}
