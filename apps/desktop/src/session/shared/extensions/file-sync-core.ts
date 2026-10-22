import { accessTokenExpirySeconds, userIdFromSupabaseAccessToken } from '@gugu/core/cloud/runtimeAuthProvider';
import type { ExtensionCapability } from './manifest';
import {
  FRAME_TYPE,
  SYNC_STEP_2,
  encodeAuthFrame,
  encodeCloseFrame,
  encodeReadOnlySyncReply,
  encodeSyncUpdateFrame,
  isBareFrame,
  readAuthAnswer,
  readCloseFrame,
  readFrameHead,
  readSyncStatus,
  splitRoutingKey,
  type SyncRevokeReason,
  type SyncToMain,
  type SyncToPage,
} from './app-runtime-protocol';

/**
 * The App file sync relay (L3-runtime-interface.md §3, §4): the half of `gugu.files` that holds the
 * connection and the credential. On the desktop it runs in main; on the phone in the outer gugu
 * page around the App's iframe (真源 §2.2: 凭证只在主进程，手机上是外层咕咕页面). Same code both
 * places — only how a socket is opened and a page is reached differs (`FileSyncPlatform`, `PagePort`).
 *
 * - **One connection per machine and identity.** Every App page's open file traffic rides one WebSocket
 *   to the file service, opened here with the account's token in the subprotocol
 *   (`['gugu-files.v1', 'bearer.<JWT>']`, 真源 §2.2). No page ever holds the token. A file an App's
 *   program opens for one of this person's agents (摩擦单 F16: handed to it in that agent's call) rides a
 *   connection of its own that acts as that agent (`as.<agentUuid>` besides the bearer): the service
 *   judges it by the agent's own membership and stamps it as the agent, as its HTTP side does.
 * - **Bytes only.** A page's replica and provider live in the page; here we move Hocuspocus
 *   frames between its port and the socket, reading nothing but the routing key at the front
 *   (`<docName>\0<session>`) and, for read-only grants, whether a Sync frame would change the
 *   document. The relay never decodes Yjs.
 * - **Admission per frame.** A page may only speak for open files granted to it (`grant`), and a
 *   grant exists only because `files.open` resolved it from the page's binding (原则 9).
 *   A frame for anything else is dropped and the page told `denied`.
 * - **Nothing handed over is lost.** When a page goes, what it already gave us is written
 *   out and its document connections closed on its behalf; if it left a `will` (changes the
 *   open file never confirmed while it was offline), we deliver it once we can.
 * - **A task's working copy is served here too** (desktop): documents named `wc:…` go to the
 *   platform's local file service on a connection of their own (`connectLocal`), with no token and
 *   no network. Everything else — grants, admission, wills — is the same path.
 */

/** A task working copy's documents (the desktop's local file service) are named `wc:<key>@<gen>`. */
export const LOCAL_DOC_PREFIX = 'wc:';
export const isLocalDoc = (docName: string) => docName.startsWith(LOCAL_DOC_PREFIX);

export interface Grant {
  docName: string;
  itemId: string;
  access: 'rw' | 'ro';
  /** The capability the grant rests on; `null` for the file the host handed the page. */
  needs: ExtensionCapability | null;
  /** F16 The agent (a uuid) this file is open for: its frames ride the connection acting as that agent. */
  asAgent?: string;
  /**
   * Let go of — the page closed it, or its binding is over (`unbound`): no new connection on it, and the ones the page
   * has finish with the page's own Close, its last frames first; the grant goes with the last of them (F106). Holds
   * who waits for that (`revoke` … `unbound`).
   */
  lettingGo?: (() => void)[];
}

/** How the relay reaches a page: its end of the page's sync port. */
export interface PagePort {
  post(message: SyncToPage | ArrayBuffer): void;
  close(): void;
}

export interface PageSync {
  id: number;
  extensionId: string;
  port: PagePort;
  grants: Map<string, Grant>;
  /** Routing keys this page has spoken on, and the socket each lives on. */
  keys: Map<string, SyncConnection>;
  /** open file → the page's unconfirmed state while offline. */
  wills: Map<string, Uint8Array>;
  /** Sent `hello`, waiting for the machine's connection to be open. */
  waitingUp: boolean;
  /** Working-copy files taken back as `deleted`, waited for to come back (`back`): open file → stop waiting. */
  returns: Map<string, () => void>;
  /** Stops watching whatever the platform watches for this page. */
  detach?: () => void;
}

/** What the platform's socket tells the relay. */
export interface SocketEvents {
  open(): void;
  message(frame: Uint8Array): void;
  close(code: number, reason: string): void;
  error(message: string): void;
  /** A transport-level pong (only where the socket can ping, see `ping`). */
  pong(): void;
}

export interface SocketHandle {
  send(frame: Uint8Array): void;
  close(code: number, reason: string): void;
  /** Transport-level ping; `false` where there is none (a browser WebSocket). */
  ping(): boolean;
  /** Drop it now, without a closing handshake. */
  terminate(): void;
}

export interface FileSyncPlatform {
  /** `ws(s)://…` of the file service. */
  serviceUrl(): string;
  connect(url: string, protocols: string[], events: SocketEvents): SocketHandle;
  /** The local file service of task working copies (`wc:` documents), where there is one: the desktop. */
  connectLocal?(events: SocketEvents): SocketHandle;
  /** Its file deleted on the disk: `back` once a file is at that path again. The answer stops waiting. */
  awaitLocalReturn?(docName: string, back: () => void): () => void;
  /** The signed-in account's access token, or null when signed out. */
  token(): Promise<string | null>;
  hasCapability(extensionId: string, capability: ExtensionCapability): boolean;
  warn(message: string, data?: Record<string, unknown>): void;
  /** One line per step of a page's way into its open files (hello → up, the connection's open / close): 摩擦单 F28. */
  note?(message: string, data?: Record<string, unknown>): void;
}

interface Will {
  docName: string;
  update: Uint8Array;
  key: string;
  timer: ReturnType<typeof setTimeout>;
}

/** An unsaved change a page left behind, and who it was written as (the person: `null`). */
interface OrphanWill {
  docName: string;
  update: Uint8Array;
  asAgent: string | null;
}

/** The connections are kept per identity: the person (`''`), or one of their agents. */
const identityKey = (asAgent: string | null) => asAgent ?? '';

type Owner = { kind: 'page'; page: PageSync } | { kind: 'will'; will: Will };

const SUBPROTOCOL = 'gugu-files.v1';
/** A token closer than this to expiry does not take new open files: the service verifies it at each Auth. */
const TOKEN_MIN_REMAINING_MS = 10 * 60_000;
const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
const IDLE_CLOSE_MS = 30_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const WILL_TIMEOUT_MS = 30_000;
const ACCOUNT_CHECK_MS = 60_000;
/**
 * A page told its file is no longer its (`unbound`) closes the connection itself, its last frames going first (F106).
 * One that has not within this long is closed by main: past its call, a program writes nothing.
 */
const LET_GO_MS = 5_000;

/** `http(s)://…` → `ws(s)://…`. */
export function webSocketUrl(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
}

function randomHex(bytes: number): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class SyncConnection {
  readonly handle: SocketHandle;
  readonly userId: string;
  readonly expiresAt: number;
  /** The local file service's connection (task working copies), not the file service's. */
  readonly local: boolean;
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  readonly owners = new Map<string, Owner>();
  private readonly queued: Uint8Array[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** `{ token }`: the file service, with the account's token; `'local'`: the platform's local file service (no credential). */
  constructor(
    private readonly relay: FileSyncRelay,
    to: { token: string } | 'local',
    /** Acting as this agent of the person's (F16), or as the person: `null`. */
    readonly asAgent: string | null = null,
  ) {
    const events: SocketEvents = {
      open: () => this.opened(),
      message: (frame) => relay.fromService(this, frame),
      pong: () => {
        if (this.pongDeadline) clearTimeout(this.pongDeadline);
        this.pongDeadline = null;
      },
      close: (code, reason) => this.closed(code, reason || 'closed'),
      // `close` follows; this only says why.
      error: (message) => relay.platform.warn('File sync: connection error', { message }),
    };
    if (to === 'local') {
      this.local = true;
      this.userId = '';
      this.expiresAt = Number.POSITIVE_INFINITY;
      this.handle = relay.platform.connectLocal!(events);
      return;
    }
    this.local = false;
    this.userId = userIdFromSupabaseAccessToken(to.token) ?? '';
    const exp = accessTokenExpirySeconds(to.token);
    this.expiresAt = exp === null ? Number.POSITIVE_INFINITY : exp * 1000;
    // One `as.` at most: the service refuses two, and a WebSocket refuses a repeated subprotocol.
    const protocols = [SUBPROTOCOL, `bearer.${to.token}`, ...(asAgent ? [`as.${asAgent}`] : [])];
    this.handle = relay.platform.connect(relay.platform.serviceUrl(), protocols, events);
  }

  get acceptsNewFiles(): boolean {
    return this.state !== 'closed' && this.expiresAt - Date.now() > TOKEN_MIN_REMAINING_MS;
  }

  send(frame: Uint8Array): void {
    if (this.state === 'open') this.handle.send(frame);
    else if (this.state === 'connecting') this.queued.push(frame);
  }

  own(key: string, owner: Owner): void {
    this.owners.set(key, owner);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  release(key: string): void {
    this.owners.delete(key);
    if (this.owners.size === 0 && !this.idleTimer && this.state !== 'closed') {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.owners.size === 0 && this.relay.mayClose(this)) this.close(1000, 'idle');
      }, IDLE_CLOSE_MS);
    }
  }

  close(code: number, reason: string): void {
    if (this.state === 'closed') return;
    this.handle.close(code, reason);
    this.closed(code, reason);
  }

  private opened(): void {
    this.state = 'open';
    for (const frame of this.queued.splice(0)) this.handle.send(frame);
    this.pingTimer = setInterval(() => {
      if (this.state !== 'open' || !this.handle.ping()) return;
      this.pongDeadline ??= setTimeout(() => {
        this.relay.platform.warn('File sync: no pong, dropping the connection');
        this.handle.terminate();
        this.closed(4408, 'no-pong');
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
    this.relay.socketOpened(this);
  }

  private closed(code: number, reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.queued.length = 0;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongDeadline) clearTimeout(this.pongDeadline);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.relay.socketClosed(this, code, reason);
  }
}

export class FileSyncRelay {
  private readonly pages = new Map<number, PageSync>();
  /** The connection new open files go to, per identity (`identityKey`). */
  private readonly currents = new Map<string, SyncConnection>();
  /** The local file service's connection: in-process, opened on first use, never idle-closed. */
  private local: SyncConnection | null = null;
  private readonly sockets = new Set<SyncConnection>();
  private readonly orphanWills: OrphanWill[] = [];
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private accountTimer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly platform: FileSyncPlatform) {}

  // ─── pages ────────────────────────────────────────────────────────────────

  page(id: number): PageSync | undefined {
    return this.pages.get(id);
  }

  /**
   * A page's open files state, over the port the platform made for it. The platform delivers the
   * page's messages to `fromPage` and calls `pageGone` when the page's document ends.
   */
  attachPage(id: number, extensionId: string, port: PagePort, detach?: () => void): PageSync {
    const page: PageSync = {
      id,
      extensionId,
      port,
      grants: new Map(),
      keys: new Map(),
      wills: new Map(),
      waitingUp: false,
      returns: new Map(),
      ...(detach ? { detach } : {}),
    };
    this.pages.set(id, page);
    this.watchAccount();
    return page;
  }

  grant(page: PageSync, grant: Grant): void {
    // Granted again while being let go of: the connections it has go on under this grant, so nothing waits for them —
    // and the bound set for the last one would otherwise take this one's (L4: `not-granted` 5 s after a retarget).
    for (const done of page.grants.get(grant.docName)?.lettingGo ?? []) done();
    page.grants.set(grant.docName, grant);
    // F16 A file opened for an agent: its connection starts opening now, before the page's first frame for it.
    if (grant.asAgent) this.ensureFor(grant.asAgent);
  }

  /**
   * The page is done with a open file (`files.close`). Its last frames and its Close may still be on their way — they
   * come by the sync port, this by the bridge — so the connections finish with the page's own Close (F106). A deleted
   * one is not waited for any more (F92).
   */
  ungrant(id: number, docName: string): void {
    const page = this.pages.get(id);
    if (!page) return;
    page.returns.get(docName)?.();
    page.returns.delete(docName);
    const grant = page.grants.get(docName);
    if (!grant) return;
    grant.lettingGo ??= [];
    this.connectionClosed(page, docName);
  }

  /**
   * Take open files back from a page. `reason` `null` retires a open file without telling the page — only for the old
   * epoch of a file the page is itself reopening, which it already knows is dead.
   *
   * `unbound` is an ordinary end (the call that handed a program the file is over; the page moved on): the page is
   * told and closes the connection itself, its last frames first, and this resolves once it has — so a program's
   * answer goes back after its writes are handed to the service, ahead of the Close (not yet confirmed by it). Past
   * LET_GO_MS main closes it on the page's behalf. Any other reason (a capability or a group gone, signed out) closes
   * the connections here and now: a person taken out of a group is cut off at once (真源原则 9).
   */
  revoke(id: number, reason: SyncRevokeReason | null, docNames?: (grant: Grant) => boolean): Promise<void> {
    const page = this.pages.get(id);
    if (!page) return Promise.resolve();
    const letGo: Promise<void>[] = [];
    for (const grant of [...page.grants.values()]) {
      if (docNames && !docNames(grant)) continue;
      if (reason === 'unbound') {
        const waiting = (grant.lettingGo ??= []);
        letGo.push(
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              this.closeConnections(page, grant.docName);
              this.dropGrant(page, grant.docName);
            }, LET_GO_MS);
            waiting.push(() => {
              clearTimeout(timer);
              resolve();
            });
          }),
        );
        this.post(page, { t: 'revoked', docName: grant.docName, reason });
        this.connectionClosed(page, grant.docName);
        continue;
      }
      this.cut(page, grant.docName);
      if (reason) this.post(page, { t: 'revoked', docName: grant.docName, reason });
    }
    return Promise.all(letGo).then(() => undefined);
  }

  /** Taken back now, what it had not saved with it: what the page sends on it after goes nowhere. */
  private cut(page: PageSync, docName: string): void {
    page.wills.delete(docName);
    this.closeConnections(page, docName);
    this.dropGrant(page, docName);
  }

  /** The page's connections to `docName` closed on its behalf. */
  private closeConnections(page: PageSync, docName: string): void {
    for (const [key, socket] of [...page.keys]) {
      if (splitRoutingKey(key).docName !== docName) continue;
      socket.send(encodeCloseFrame(key));
      socket.release(key);
      page.keys.delete(key);
    }
  }

  /**
   * The grant goes. One let go of (not cut) that leaves a will — what the page wrote while the service was out of
   * reach — hands it on to be delivered, as the page's own identity wrote it (F106, L3).
   */
  private dropGrant(page: PageSync, docName: string): void {
    const grant = page.grants.get(docName);
    if (!grant) return;
    page.grants.delete(docName);
    const will = page.wills.get(docName);
    if (grant.lettingGo && will) {
      page.wills.delete(docName);
      this.orphanWills.push({ docName, update: will, asAgent: grant.asAgent ?? null });
      this.deliverWills();
    }
    for (const done of grant.lettingGo ?? []) done();
  }

  /** One of the page's connections to `docName` closed: a grant being let go of goes with the last of them. */
  private connectionClosed(page: PageSync, docName: string): void {
    if (!page.grants.get(docName)?.lettingGo) return;
    for (const key of page.keys.keys()) if (splitRoutingKey(key).docName === docName) return;
    this.dropGrant(page, docName);
  }

  revokeExtension(extensionId: string, reason: SyncRevokeReason): void {
    for (const page of this.pages.values()) {
      if (page.extensionId === extensionId) this.revoke(page.id, reason);
    }
  }

  private post(page: PageSync, message: SyncToPage | ArrayBuffer): void {
    try {
      page.port.post(message);
    } catch {
      // The page is going; `pageGone` does the rest.
    }
  }

  fromPage(page: PageSync, data: unknown): void {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const frame =
        data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.frameFromPage(page, frame);
      return;
    }
    const message = data as SyncToMain;
    if (message?.t === 'hello') {
      this.hello(page);
      return;
    }
    if (message?.t === 'will' && typeof message.docName === 'string' && page.grants.get(message.docName)?.access === 'rw') {
      if (message.update instanceof ArrayBuffer) page.wills.set(message.docName, new Uint8Array(message.update));
      else page.wills.delete(message.docName);
    }
  }

  /**
   * The page's socket is (re)opening. Whatever document connections it still holds on the
   * service are stale — its providers are about to authenticate again, and the service
   * refuses a second Auth on a live connection — so close them first, in order.
   */
  private hello(page: PageSync): void {
    for (const [key, socket] of page.keys) {
      socket.send(encodeCloseFrame(key));
      socket.release(key);
    }
    page.keys.clear();
    for (const docName of [...page.grants.keys()]) this.connectionClosed(page, docName);
    // A page whose open files are all in a task's working copy needs only the local service, which is up as soon as
    // it exists (frames sent before it opens wait in its queue). Any group file needs the person's connection.
    // ⚠️ `up` / `down` is per page (one socket per page), so this rests on a page being all-local or all-group —
    // true today because a task surface opens only its working copy (app-files `workingCopy`). Were a session page to
    // open group files too (an `about`, an F16 program in a task), a signed-out person's local files would wait
    // behind the file service's `up`: split the page's socket per connection before allowing that.
    const socket = this.localOnly(page) ? this.ensureLocal() : this.ensureCurrent();
    if (socket && (socket.state === 'open' || socket.local)) {
      page.waitingUp = false;
      this.post(page, { t: 'up' });
    } else {
      page.waitingUp = true;
    }
    this.platform.note?.('File sync: hello', { page: page.id, extensionId: page.extensionId, connection: socket?.state ?? 'none', up: !page.waitingUp });
  }

  /** A page whose open files are all in a task's working copy (and it has some): the file service is not its concern. */
  private localOnly(page: PageSync): boolean {
    return page.grants.size > 0 && [...page.grants.keys()].every(isLocalDoc);
  }

  private frameFromPage(page: PageSync, frame: Uint8Array): void {
    if (isBareFrame(frame, FRAME_TYPE.Pong) || isBareFrame(frame, FRAME_TYPE.Ping)) return;
    const head = readFrameHead(frame);
    if (!head) {
      this.platform.warn('File sync: dropped a malformed frame from a page', { extensionId: page.extensionId });
      return;
    }
    const { docName } = splitRoutingKey(head.key);
    const grant = page.grants.get(docName);
    if (!grant) {
      this.post(page, { t: 'denied', key: head.key, reason: 'not-granted' });
      return;
    }
    // Read at every frame, like every bridge call: a capability taken back mid-session
    // stops the next frame, not the next restart.
    if (grant.needs && !this.platform.hasCapability(page.extensionId, grant.needs)) {
      this.revoke(page.id, 'capability', (g) => g.docName === docName);
      return;
    }
    if (grant.access === 'ro' && head.type === FRAME_TYPE.Sync) {
      // Yjs Step 2 repeats the whole delete set even when this replica only read the service's content.
      // A reader sends no content back, but must finish the handshake so the provider gets its confirmation.
      if (head.syncStep === SYNC_STEP_2) frame = encodeReadOnlySyncReply(head.key);
      else if (head.carriesUpdate) {
        this.post(page, { t: 'denied', key: head.key, reason: 'read-only' });
        return;
      }
    }
    let socket = page.keys.get(head.key);
    // A Close for a key this page does not hold on the service has nothing to close — and the
    // service would queue it as pre-auth traffic and close the NEXT connection on that key.
    if (!socket && head.type === FRAME_TYPE.Close) return;
    if (!socket) {
      // Let go of (F106): the connections the page has may finish, no new one opens.
      if (grant.lettingGo) {
        this.post(page, { t: 'denied', key: head.key, reason: 'not-granted' });
        return;
      }
      // A working copy's file: the local service. A group's: the identity it was granted for — the person, or the
      // agent a program opened it for.
      socket = (isLocalDoc(docName) ? this.ensureLocal() : this.ensureFor(grant.asAgent ?? null)) ?? undefined;
      if (!socket && grant.asAgent && this.opening.has(identityKey(grant.asAgent))) {
        // The agent's connection is being opened (the page's `up` is the person's): the frame waits for it,
        // in order, instead of the page being told `down` for a connection that is on its way.
        const waiting = this.waitingFrames.get(grant.asAgent) ?? [];
        waiting.push({ page, key: head.key, frame });
        this.waitingFrames.set(grant.asAgent, waiting);
        return;
      }
      if (!socket) {
        // The connection went between our `up` and this frame. Said to the page now — not assumed
        // said: a page that had been told `up` but held no open file yet was told nothing when it went,
        // and its provider waited for an answer forever (摩擦单 F28). `down` makes it say `hello` again.
        this.platform.note?.('File sync: a frame found no connection; the page is told down', { page: page.id });
        this.post(page, { t: 'down', code: 1006, reason: 'no-connection' });
        return;
      }
      const owner = socket.owners.get(head.key);
      if (owner && !(owner.kind === 'page' && owner.page === page)) {
        this.post(page, { t: 'denied', key: head.key, reason: 'key-in-use' });
        return;
      }
      // A key opens with its Auth. Anything else on a key the page does not hold is left over from a connection that
      // is gone — closed, or refused before these frames came: the service would keep them for an Auth that never comes.
      if (!owner && head.type !== FRAME_TYPE.Auth) return;
      socket.own(head.key, { kind: 'page', page });
      page.keys.set(head.key, socket);
    }
    socket.send(frame);
    if (head.type === FRAME_TYPE.Close) {
      socket.release(head.key);
      page.keys.delete(head.key);
      this.connectionClosed(page, docName);
    }
  }

  /** The page is gone: finish what it handed over, close its connections, keep its wills. */
  pageGone(id: number): void {
    const page = this.pages.get(id);
    if (!page) return;
    this.pages.delete(id);
    page.detach?.();
    for (const stop of page.returns.values()) stop();
    page.returns.clear();
    for (const [key, socket] of page.keys) {
      // Its earlier frames are ahead of this one on the socket: they land first.
      socket.send(encodeCloseFrame(key));
      socket.release(key);
    }
    page.keys.clear();
    for (const [docName, update] of page.wills) {
      this.orphanWills.push({ docName, update, asAgent: page.grants.get(docName)?.asAgent ?? null });
    }
    page.wills.clear();
    // Whatever it was letting go of is let go of now: its connections are closed above.
    for (const docName of [...page.grants.keys()]) this.dropGrant(page, docName);
    try {
      page.port.close();
    } catch {
      // already closed
    }
    this.deliverWills();
  }

  /** An empty socket may go — unless it is the one pages are waiting on, or wills need. The local one stays. */
  mayClose(socket: SyncConnection): boolean {
    if (socket.local) return false;
    if (socket !== this.currents.get(identityKey(socket.asAgent))) return true;
    if (socket.asAgent === null) for (const page of this.pages.values()) if (page.waitingUp) return false;
    return !this.orphanWills.some((will) => !isLocalDoc(will.docName) && will.asAgent === socket.asAgent);
  }

  // ─── the machine's connections ────────────────────────────────────────────

  private tokenPromise: Promise<string | null> | null = null;
  private readonly opening = new Set<string>();
  /** Frames for an agent's files that came while its connection was being opened, in order (F16). */
  private readonly waitingFrames = new Map<string, Array<{ page: PageSync; key: string; frame: Uint8Array }>>();

  /** The agent's connection exists now: what was waiting for it goes out on it, first. */
  private flushWaiting(asAgent: string, socket: SyncConnection | null): void {
    const waiting = this.waitingFrames.get(asAgent);
    if (!waiting) return;
    this.waitingFrames.delete(asAgent);
    for (const { page, key, frame } of waiting) {
      // Gone, or the file taken back meanwhile: nothing of it goes out.
      if (this.pages.get(page.id) !== page || !page.grants.has(splitRoutingKey(key).docName)) continue;
      if (!socket) {
        this.post(page, { t: 'down', code: 1006, reason: 'no-connection' });
        continue;
      }
      if (!page.keys.has(key)) {
        socket.own(key, { kind: 'page', page });
        page.keys.set(key, socket);
      }
      socket.send(frame);
    }
  }

  /**
   * The local file service's connection, opened on first use (null where the platform has none). It is a call into this
   * process: one that throws is a bug, not an outage, and goes up.
   */
  private ensureLocal(): SyncConnection | null {
    if (!this.platform.connectLocal) return null;
    if (!this.local || this.local.state === 'closed') this.local = new SyncConnection(this, 'local');
    return this.local;
  }

  /** The person's connection: what pages say `hello` to and are told `up` / `down` by. */
  private ensureCurrent(): SyncConnection | null {
    return this.ensureFor(null);
  }

  /** The socket new open files of this identity go to — opening one when there is none, or the token is ending. */
  private ensureFor(asAgent: string | null): SyncConnection | null {
    const current = this.currents.get(identityKey(asAgent));
    if (current?.acceptsNewFiles) return current;
    if (!this.opening.has(identityKey(asAgent))) void this.openSocket(asAgent);
    return current?.state === 'open' || current?.state === 'connecting' ? current : null;
  }

  private async openSocket(asAgent: string | null): Promise<void> {
    const identity = identityKey(asAgent);
    this.opening.add(identity);
    try {
      const token = await (this.tokenPromise ??= this.platform.token().finally(() => {
        this.tokenPromise = null;
      }));
      if (!token) {
        if (asAgent === null) this.tellWaiting({ t: 'down', code: 4401, reason: 'signed-out' });
        else this.flushWaiting(asAgent, null);
        return;
      }
      const socket = new SyncConnection(this, { token }, asAgent);
      this.sockets.add(socket);
      // The one it replaces keeps the open files it has (the service only checks a token at Auth)
      // and closes once they are gone.
      const previous = this.currents.get(identity);
      this.currents.set(identity, socket);
      if (previous && previous.owners.size === 0) previous.close(1000, 'rotated');
      if (asAgent !== null) this.flushWaiting(asAgent, socket);
    } catch (error) {
      this.platform.warn('File sync: could not open the connection', { message: error instanceof Error ? error.message : String(error) });
      if (asAgent !== null) this.flushWaiting(asAgent, null);
      this.scheduleReconnect();
    } finally {
      this.opening.delete(identity);
    }
  }

  socketOpened(socket: SyncConnection): void {
    // Pages of a working copy were told `up` at `hello`; only wills wait for it.
    if (socket.local) {
      this.deliverWills();
      return;
    }
    this.reconnectDelay = RECONNECT_MIN_MS;
    const current = socket === this.currents.get(identityKey(socket.asAgent));
    this.platform.note?.('File sync: connection open', { current, asAgent: socket.asAgent !== null });
    if (!current) return;
    // Pages say `hello` to the person's connection; an agent's carries only what was opened for it.
    if (socket.asAgent === null) this.tellWaiting({ t: 'up' });
    this.deliverWills();
  }

  socketClosed(socket: SyncConnection, code: number, reason: string): void {
    this.sockets.delete(socket);
    if (socket === this.local) this.local = null;
    const identity = identityKey(socket.asAgent);
    const wasCurrent = !socket.local && this.currents.get(identity) === socket;
    if (wasCurrent) this.currents.delete(identity);
    this.platform.note?.('File sync: connection closed', { code, reason, current: wasCurrent, owners: socket.owners.size, asAgent: socket.asAgent !== null });
    const affected = new Set<PageSync>();
    for (const [key, owner] of socket.owners) {
      if (owner.kind === 'page') {
        owner.page.keys.delete(key);
        this.connectionClosed(owner.page, splitRoutingKey(key).docName);
        affected.add(owner.page);
      } else {
        clearTimeout(owner.will.timer);
        this.orphanWills.push({ docName: owner.will.docName, update: owner.will.update, asAgent: socket.asAgent });
      }
    }
    socket.owners.clear();
    // A page whose open files were on it reconnects (its provider retries, sending `hello`).
    for (const page of affected) this.post(page, { t: 'down', code, reason });
    // Every other page too when it was THE person's connection — waiting ones, and ones told `up` that hold no
    // open file on it yet (their next frame would have found nothing: 摩擦单 F28). Nobody waits on the local one, and
    // a page of a working copy only is not told the file service went.
    if (socket.asAgent === null && !socket.local) {
      for (const page of this.pages.values()) {
        if (!affected.has(page) && (page.waitingUp || (wasCurrent && !this.localOnly(page)))) this.post(page, { t: 'down', code, reason });
        page.waitingUp = false;
      }
    }
    if (code !== 1000 && (affected.size > 0 || this.orphanWills.length > 0)) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.orphanWills.length > 0) this.deliverWills();
    }, delay);
  }

  private tellWaiting(message: SyncToPage): void {
    for (const page of this.pages.values()) {
      if (!page.waitingUp) continue;
      page.waitingUp = false;
      this.post(page, message);
    }
  }

  fromService(socket: SyncConnection, frame: Uint8Array): void {
    if (isBareFrame(frame, FRAME_TYPE.Ping)) {
      socket.send(Uint8Array.of(FRAME_TYPE.Pong));
      return;
    }
    const head = readFrameHead(frame);
    if (!head) return;
    const owner = socket.owners.get(head.key);
    if (!owner) return;
    if (owner.kind === 'will') {
      this.willAnswer(socket, owner.will, frame);
      return;
    }
    const { page } = owner;
    // An exact-size copy: the platform's buffer may view a larger pooled allocation.
    this.post(page, frame.slice().buffer);
    // Refused (stale, not found): the service holds no connection on this key, so none is the page's to close any more
    // — a Close of ours there (retiring the old epoch, a `hello`) opens a queue at the service that never clears.
    if (head.type === FRAME_TYPE.Auth && readAuthAnswer(frame)?.ok === false) {
      socket.release(head.key);
      page.keys.delete(head.key);
      this.connectionClosed(page, splitRoutingKey(head.key).docName);
      return;
    }
    if (head.type === FRAME_TYPE.Close) {
      socket.release(head.key);
      page.keys.delete(head.key);
      const { docName } = splitRoutingKey(head.key);
      // The service closed one document connection. Two reasons end the grant; the others
      // (`rate-limited`, `too-large`) are the page's to handle (open file-file.ts `documentClosed`).
      const reason = readCloseFrame(frame)?.reason;
      if (reason === 'deleted' || reason === 'removed-from-group') {
        const held = page.grants.has(docName);
        this.revoke(page.id, reason, (g) => g.docName === docName);
        // A working copy's file is its path: deleted on the disk, it can come back (git checkout, an undo) — 摩擦单 F92.
        if (held && reason === 'deleted' && isLocalDoc(docName)) this.awaitReturn(page, docName);
      } else {
        this.connectionClosed(page, docName);
      }
    }
  }

  /** Until the page closes the file or goes: when the file is on the disk again, the page hears `back` and reopens it. */
  private awaitReturn(page: PageSync, docName: string): void {
    if (!this.platform.awaitLocalReturn || page.returns.has(docName)) return;
    const stop = this.platform.awaitLocalReturn(docName, () => {
      page.returns.delete(docName);
      if (this.pages.get(page.id) === page) this.post(page, { t: 'back', docName });
    });
    page.returns.set(docName, stop);
  }

  // ─── wills ────────────────────────────────────────────────────────────────

  /**
   * Hand each orphaned will to the service on a document connection of the relay's own: Auth,
   * the update, wait for the save acknowledgement, Close. The update is the page's bytes.
   */
  private deliverWills(): void {
    // A working copy's on the local service; a group file's on a connection of the identity it was written as (an
    // agent's change is the agent's).
    if (this.orphanWills.some((will) => isLocalDoc(will.docName))) {
      const local = this.ensureLocal();
      if (local?.state === 'open') this.deliverOn(local, (will) => isLocalDoc(will.docName));
    }
    for (const asAgent of new Set(this.orphanWills.filter((will) => !isLocalDoc(will.docName)).map((will) => will.asAgent))) {
      const socket = this.ensureFor(asAgent);
      if (socket?.state === 'open') this.deliverOn(socket, (will) => !isLocalDoc(will.docName) && will.asAgent === asAgent);
    }
  }

  private deliverOn(socket: SyncConnection, isMine: (will: OrphanWill) => boolean): void {
    const mine = this.orphanWills.filter(isMine);
    this.orphanWills.splice(0, this.orphanWills.length, ...this.orphanWills.filter((will) => !isMine(will)));
    for (const { docName, update } of mine) {
      const key = `${docName}\0will-${randomHex(6)}`;
      const will: Will = {
        docName,
        update,
        key,
        timer: setTimeout(() => {
          this.platform.warn('File sync: an unsaved change was not confirmed in time', { docName });
          socket.send(encodeCloseFrame(key));
          socket.release(key);
        }, WILL_TIMEOUT_MS),
      };
      socket.own(key, { kind: 'will', will });
      socket.send(encodeAuthFrame(key, ''));
      socket.send(encodeSyncUpdateFrame(key, update));
    }
  }

  private willAnswer(socket: SyncConnection, will: Will, frame: Uint8Array): void {
    const auth = readAuthAnswer(frame);
    if (auth && !auth.ok) {
      // stale-epoch included: a will carries no text to replay by edit(old, new).
      this.platform.warn('File sync: an unsaved change was refused', { docName: will.docName, reason: auth.reason });
      clearTimeout(will.timer);
      socket.release(will.key);
      return;
    }
    const status = readSyncStatus(frame);
    if (status?.saved) {
      clearTimeout(will.timer);
      socket.send(encodeCloseFrame(will.key));
      socket.release(will.key);
    }
  }

  // ─── the account ──────────────────────────────────────────────────────────

  /**
   * Signed out, or another account: every connection opened with the old token goes, and
   * every page loses its group files (a working copy's stay: the disk is not the account's). Checked on a slow
   * timer while any page holds open files — the token reader already answers from a short memo.
   */
  private watchAccount(): void {
    if (this.accountTimer) return;
    this.accountTimer = setInterval(() => {
      if (this.pages.size === 0 && this.sockets.size === 0) {
        if (this.accountTimer) clearInterval(this.accountTimer);
        this.accountTimer = null;
        return;
      }
      void this.platform.token().then((token) => {
        const userId = token ? userIdFromSupabaseAccessToken(token) : null;
        for (const socket of [...this.sockets]) {
          if (socket.userId && socket.userId === userId) continue;
          for (const page of this.pages.values()) this.revoke(page.id, 'signed-out', (grant) => !isLocalDoc(grant.docName));
          socket.close(4401, 'signed-out');
        }
      });
    }, ACCOUNT_CHECK_MS);
  }
}
