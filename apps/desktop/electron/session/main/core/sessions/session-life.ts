import { hydrateLife, OUTCOME_UNKNOWN, shouldStartOnHydrate, step } from '@gugu/core/local/session-life/step';
import { STAGES } from '@gugu/core/local/session-life/types';
import { toSerializedError } from '@gugu/session-shared/result';
import type {
  Attempt, AuthEpoch, Effect, Event, Gen, Hold, InterruptEvent, Life,
  PendingView, RunStageEffect, Seq, SerializedError, StageResult,
} from '@gugu/core/local/session-life/types';
import type { LifeStatus, LifeView } from '@shared/core/sessions/session-life';
import type { LegAdapter, PendingRow } from './session-life-adapter';
import type { EnqueuePending } from './session-pending';

export interface LifeStore {
  read(sessionId: string): { archived: boolean; hold: Hold | null };
  pending(sessionId: string): PendingView;
  row(sessionId: string, seq: Seq): PendingRow;
  /** The rows not yet accepted (the projection's pending items); accepted ones are the transcript's. */
  unaccepted(sessionId: string): readonly PendingRow[];
  /** One transaction: body, queue row and frozen batch membership; a duplicate returns the existing row. */
  enqueue(input: EnqueuePending): { inserted: boolean; seq: Seq; state: PendingRow['state'] };
  commit(sessionId: string, effects: readonly Effect[]): void;
  /** Claim only this session's interrupted dispatches (now unknown, never replayed); returns the rows it claimed. */
  claim(sessionId: string): readonly Seq[];
  acceptedUnsettled(sessionId: string): readonly Seq[];
  settleRead(sessionId: string, seq: Seq): void;
  remove(sessionId: string): void;
}

export interface SessionLifePorts {
  /** The persisted sessions boot hydrate walks; a runtime fork is never among them. */
  sessions(): readonly string[];
  /** A persisted session lives in the database store, a runtime fork (side chat) in the memory store. */
  store(sessionId: string): LifeStore;
  adapter(sessionId: string): LegAdapter;
  /** The runtime forks whose life depends on this session; a fork's own parent, or null for a persisted session. */
  forks(sessionId: string): readonly string[];
  /** Every open side chat, entered (sent to) or not. */
  allForks(): readonly string[];
  parentOf(sessionId: string): string | null;
  /** Hydrate only: the session's canonical binding names exactly this account (unknown owner = false). */
  ownedBy(sessionId: string, userId: string): Promise<boolean>;
  markRead(row: PendingRow): Promise<void>;
  reportFailure(rows: readonly PendingRow[], cause: SerializedError): Promise<void>;
  publish(view: LifeView): void;
  removed(sessionId: string): void;
  failed(sessionId: string, error: unknown): void;
  now(): number;
}

interface Run {
  readonly gen: Gen;
  readonly abort: AbortController;
  readonly adapter: LegAdapter;
  unlisten: (() => void) | null;
}

interface Entry {
  life: Life;
  /** The current attempt was started by a reconfigure (its LifeView reports preserved/replaced). */
  reconfigured: boolean;
  attempt: number;
  version: number;
  since: number;
  run: Run | null;
  /** IO ownership only. Life, not this promise, answers whether a session can accept a message. */
  effects: Promise<void>;
}

function same(a: Gen, b: Gen): boolean { return a.auth === b.auth && a.attempt === b.attempt; }
function terminal(life: Life): boolean { return life.kind === 'dormant' || life.kind === 'failed' || life.kind === 'archived'; }
/**
 * The sole session lifecycle owner. Decisions and receipt/hold commits are synchronous;
 * external IO is ordered per session, while interrupts can abort a pending stage immediately.
 */
export class SessionLife {
  private readonly entries = new Map<string, Entry>();
  /** IO of a removed entry still running: a new entry of the same id starts behind it. */
  private readonly draining = new Map<string, Promise<void>>();
  private epoch = 0;
  private account: string | null = null;
  /** The last queued auth transition; null = idle. The only fact saying whether a transition is in progress. */
  private tail: Promise<void> | null = null;
  /** v3.1 #7: from leave's first interrupt until the epoch advances, nothing may start a run. */
  private leaving = false;

  constructor(private readonly ports: SessionLifePorts) {}

  private entry(sessionId: string): Entry {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    const entry: Entry = { life: hydrateLife(this.ports.store(sessionId).read(sessionId)), reconfigured: false, attempt: 0,
      version: 0, since: this.ports.now(), run: null, effects: this.draining.get(sessionId) ?? Promise.resolve() };
    this.entries.set(sessionId, entry);
    return entry;
  }

  /**
   * The caller must await this before it replaces or clears its credentials: old-epoch teardown still uses them.
   * A rejection means sign-out did not complete (epoch unchanged); the caller decides whether to retry.
   */
  signOut(): Promise<void> { return this.transition(() => this.leave()); }

  signIn(userId: string): Promise<void> { return this.transition(() => this.enter(userId)); }

  /**
   * The account's credentials under these sessions change (a subscription switch, v3.2): the sign-out window, scoped to
   * them. They are held (interrupt sign-out, so no settle restarts one on the old credentials), `swap` runs once all are
   * down, then the same account signs back in — a session with a queued head starts on the new credentials (row 14).
   */
  rotate(sessionIds: readonly string[], swap: () => Promise<void>): Promise<void> {
    return this.transition(async () => {
      const ownerUserId = this.account;
      if (ownerUserId === null) throw new Error('Sign in before switching the credentials under a session');
      for (const sessionId of sessionIds) this.send(sessionId, { k: 'interrupt', reason: 'sign-out', ownerUserId });
      try {
        for (const sessionId of sessionIds) {
          const entry = this.entries.get(sessionId);
          if (!entry) throw new Error(`Session ${sessionId} has no lifecycle entry`);
          await this.drain(entry);
          if (!terminal(entry.life)) throw new Error(`Session ${sessionId} did not stop for the credential switch`);
        }
        await swap();
      } finally {
        for (const sessionId of sessionIds) if (this.entries.has(sessionId)) this.send(sessionId, { k: 'signed-in', userId: ownerUserId });
      }
    });
  }

  private transition(run: () => Promise<void>): Promise<void> {
    // Idle: run now, so a sign-out's interrupts land before the caller replaces its credentials.
    const next = this.tail ? this.tail.then(run) : run();
    const tail: Promise<void> = next.catch(() => undefined).then(() => { if (this.tail === tail) this.tail = null; });
    this.tail = tail;
    return next;
  }

  private async leave(): Promise<void> {
    const ownerUserId = this.account;
    if (ownerUserId === null) return;
    this.leaving = true;
    try {
      // A side chat exists only for this account's run: every open one ends (an unsent one too, or the next account
      // would start it on this account's parent binding) instead of waiting for a sign-in that cannot reach it.
      for (const sessionId of new Set([...this.entries.keys(), ...this.ports.allForks()])) {
        this.send(sessionId, this.ports.parentOf(sessionId) === null
          ? { k: 'interrupt', reason: 'sign-out', ownerUserId } : { k: 'interrupt', reason: 'delete' });
      }
      for (const [sessionId, entry] of this.entries) {
        await this.drain(entry);
        if (this.entries.get(sessionId) !== entry) continue; // a fork's delete removed it
        if (!terminal(entry.life)) throw new Error(`Session ${sessionId} did not finish sign-out teardown`);
      }
    } finally {
      // v3.1 #10: a failed leave leaves the epoch where it was and reopens the account to starts.
      this.leaving = false;
    }
    // Old-epoch receipts remain valid through teardown; only terminal sessions cross the epoch.
    this.epoch += 1;
    this.account = null;
    this.entries.clear();
  }

  private async enter(userId: string): Promise<void> {
    if (this.account === userId) return;
    await this.leave();
    this.account = userId;
    this.epoch += 1;
    for (const sessionId of this.ports.sessions()) {
      // v3.1 #8: only boot hydrate filters by owner; old rows of unknown or foreign bindings stay put.
      if (!await this.ports.ownedBy(sessionId, userId)) continue;
      const unknown = this.ports.store(sessionId).claim(sessionId);
      // Rows an earlier run left mid-dispatch: unknown outcome, reported to their sources once (like an exit's).
      if (unknown.length) void this.ports.reportFailure(unknown.map(seq => this.ports.store(sessionId).row(sessionId, seq)), OUTCOME_UNKNOWN)
        .catch(error => this.ports.failed(sessionId, error));
      const entry = this.entry(sessionId);
      if (entry.life.kind === 'dormant' && entry.life.hold?.reason === 'sign-out') {
        this.send(sessionId, { k: 'signed-in', userId });
      } else if (shouldStartOnHydrate(entry.life, this.ports.store(sessionId).pending(sessionId))) {
        this.send(sessionId, { k: 'start', origin: 'retry' });
      } else this.publish(sessionId, entry);
      for (const seq of this.ports.store(sessionId).acceptedUnsettled(sessionId)) this.reconcileRead(sessionId, seq);
    }
  }

  /**
   * The only way into the queue. A live insert comes from this account's own input or reader, so it delivers
   * (v3.1 #8). A duplicate never starts anything: an accepted one retries its failed read marker, and a queued
   * one re-delivers only into ready{free}, the one state where a head must be pumped (invariant 3).
   */
  enqueue(input: EnqueuePending): { seq: Seq; state: PendingRow['state'] } {
    const result = this.ports.store(input.sessionId).enqueue(input);
    const sessionId = input.sessionId;
    if (result.inserted) this.deliver(sessionId, result.seq);
    else if (result.state === 'accepted') this.reconcileRead(sessionId, result.seq);
    else if (result.state === 'queued') {
      const life = this.entries.get(sessionId)?.life;
      if (life?.kind === 'ready' && life.admission.kind === 'free') this.send(sessionId, { k: 'deliver', seq: result.seq });
    }
    return { seq: result.seq, state: result.state };
  }

  private deliver(sessionId: string, seq: Seq): void {
    const refused = this.account === null ? 'no account is signed in' : this.leaving ? 'sign-out is in progress' : null;
    if (refused) {
      // The row stays queued; a later sign-in of its owner or an explicit start consumes it.
      this.ports.failed(sessionId, new Error(`Delivery of pending ${seq} held: ${refused}`));
      return;
    }
    this.send(sessionId, { k: 'deliver', seq });
  }

  /** Explicit user intent may enter identity to establish a previously unresolved binding. */
  start(sessionId: string, origin: 'user-open' | 'retry' | 'reconfigure' = 'user-open'): void {
    if (this.account === null) throw new Error('Sign in before starting this session');
    if (this.leaving) throw new Error('Sign-out is in progress; this session cannot start now');
    this.send(sessionId, { k: 'start', origin });
  }

  interrupt(sessionId: string, event: InterruptEvent): Promise<void> {
    const entry = this.entry(sessionId);
    this.send(sessionId, event);
    return this.drain(entry); // the entry, not the id: a delete removes it from the map before its IO ends
  }

  restore(sessionId: string): void { this.send(sessionId, { k: 'restore' }); }
  turn(sessionId: string, busy: boolean): void {
    const entry = this.entries.get(sessionId);
    if (entry?.life.kind !== 'ready' || entry.life.have.channel.timing !== 'idle-only') return;
    this.send(sessionId, { k: busy ? 'turn-busy' : 'turn-idle', gen: entry.life.gen });
  }

  read(sessionId: string): LifeView { return this.view(sessionId, this.known(sessionId)); }

  /** Kind and stage only (status feed, session_get): no pending rows read. */
  status(sessionId: string): LifeStatus {
    const entry = this.known(sessionId);
    return { kind: entry.life.kind, stage: stageOf(entry) };
  }

  private known(sessionId: string): Entry {
    return this.entries.get(sessionId) ?? { life: hydrateLife(this.ports.store(sessionId).read(sessionId)), reconfigured: false, attempt: 0,
      version: 0, since: this.ports.now(), run: null, effects: Promise.resolve() };
  }

  /** Entries whose run holds a process or is building one (starting, ready, stopping); a side chat names its parent. */
  running(): readonly { readonly sessionId: string; readonly parentId: string | null }[] {
    return [...this.entries].filter(([, entry]) => entry.life.kind === 'starting' || entry.life.kind === 'ready' || entry.life.kind === 'stopping')
      .map(([sessionId]) => ({ sessionId, parentId: this.ports.parentOf(sessionId) }));
  }

  quiescent(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    return entry ? this.drain(entry) : Promise.resolve();
  }

  private async drain(entry: Entry): Promise<void> {
    for (;;) {
      const pending = entry.effects;
      await pending;
      if (entry.effects === pending) return;
    }
  }

  private send(sessionId: string, event: Event): void {
    if ('gen' in event && !this.entries.has(sessionId)) return;
    const entry = this.entry(sessionId);
    const previous = entry.life;
    const oldRun = entry.run;
    const next: Gen = { auth: this.epoch as AuthEpoch, attempt: (entry.attempt + 1) as Attempt };
    const [life, effects] = step(previous, event, this.ports.store(sessionId).pending(sessionId), { next });
    this.ports.store(sessionId).commit(sessionId, [...effects, ...effects.flatMap((effect): Effect[] => effect.e === 'dispatch'
      ? [{ e: 'write-receipt', seq: effect.seq, receipt: { state: 'dispatching', attempt: effect.gen.attempt } }] : [])]);
    entry.life = life;
    if (life.kind === 'starting' && (!oldRun || !same(life.gen, oldRun.gen))) {
      entry.reconfigured = event.k === 'start' && event.origin === 'reconfigure';
      entry.attempt += 1;
      entry.run = { gen: life.gen, abort: new AbortController(), adapter: this.ports.adapter(sessionId), unlisten: null };
    }
    for (const effect of effects) if (effect.e === 'abort') oldRun?.abort.abort();
    if (life.kind !== previous.kind || (life.kind === 'starting' && previous.kind === 'starting' && life.progress.at !== previous.progress.at)) {
      entry.since = this.ports.now();
    }
    const removed = effects.some(effect => effect.e === 'remove');
    if (removed) {
      oldRun?.unlisten?.();
      this.ports.store(sessionId).remove(sessionId);
      this.entries.delete(sessionId);
      this.ports.removed(sessionId);
      // The internal sealed archived result of delete is never a published projection; its IO still runs below.
    } else if (previous !== life || effects.length) this.publish(sessionId, entry);
    const run = entry.run;
    const current = entry.effects.then(async () => {
      for (const effect of effects) {
        const owner = 'gen' in effect && effect.gen !== null && oldRun && same(effect.gen, oldRun.gen) ? oldRun : run;
        try {
          await this.effect(sessionId, entry, owner, effect);
        } catch (error) {
          // @@@effect-fault (v3.1 #9) - the rest of this batch no longer has its preconditions: stop here, report
          // loudly and step a fault for the session's current run. The chain itself stays resolved.
          this.ports.failed(sessionId, error);
          if (this.entries.get(sessionId) !== entry) return; // removed by delete: nothing left to step
          const life = entry.life;
          const run = life.kind === 'starting' || life.kind === 'ready' || life.kind === 'stopping' ? life.gen : null;
          this.send(sessionId, { k: 'fault', run, cause: toSerializedError(error),
            unreleased: effect.e === 'teardown' ? { gen: effect.gen, have: effect.have } : null });
          return;
        }
      }
    });
    entry.effects = current;
    if (removed) {
      this.draining.set(sessionId, current);
      void current.then(() => { if (this.draining.get(sessionId) === current) this.draining.delete(sessionId); });
    }
    void current.then(() => {
      if (this.entries.get(sessionId) === entry && entry.effects === current && entry.life.kind === 'stopping') {
        this.send(sessionId, { k: 'settled', gen: entry.life.gen });
      }
    });
  }

  private async effect(sessionId: string, entry: Entry, run: Run | null, effect: Effect): Promise<void> {
    switch (effect.e) {
      case 'run-stage': {
        if (!run || !same(run.gen, effect.gen)) throw new Error('Stage has no matching lifecycle lease');
        if (run.abort.signal.aborted) return;
        let out: StageResult;
        try {
          out = await runStage(run, effect);
        } catch (error) {
          if (!run.abort.signal.aborted) this.send(sessionId, { k: 'stage-fail', gen: run.gen, at: effect.at, cause: toSerializedError(error) });
          return;
        }
        if (run.abort.signal.aborted) { await run.adapter.teardown({ [out.at]: out.value }, { gen: run.gen }); return; }
        if (out.at === 'process') run.unlisten = run.adapter.onExit({ process: out.value }, exit => this.send(sessionId, { k: 'exit', gen: run.gen, exit }));
        this.send(sessionId, { k: 'stage-ok', gen: run.gen, out });
        return;
      }
      case 'dispatch': {
        if (!run) throw new Error('Dispatch has no lifecycle lease');
        // A stop may have overtaken a queued IO effect. No provider byte was sent in that case.
        if (entry.life.kind !== 'ready' || !same(entry.life.gen, run.gen)) {
          this.send(sessionId, { k: 'receipt', gen: run.gen, seq: effect.seq, result: 'rejected-before-admission', nativeReceiptId: null,
            cause: { name: 'AdmissionCancelled', message: 'The session stopped before dispatch' } });
          return;
        }
        let result: Awaited<ReturnType<LegAdapter['dispatch']>>;
        try {
          result = await run.adapter.dispatch(entry.life.have, this.ports.store(sessionId).row(sessionId, effect.seq), { gen: run.gen, signal: run.abort.signal });
        } catch (error) {
          // @@@dispatch-throw - bytes may have left: the channel is no longer a proven admission path.
          // Exit records this row as unknown (never replayed) and restarts only for the rows behind it.
          this.send(sessionId, { k: 'exit', gen: run.gen, exit: { cause: toSerializedError(error), code: null, signal: null } });
          return;
        }
        switch (result.result) {
          case 'accepted':
            this.send(sessionId, { k: 'receipt', gen: run.gen, seq: effect.seq, result: 'accepted', nativeReceiptId: result.nativeReceiptId });
            return;
          case 'rejected-before-admission':
            this.send(sessionId, { k: 'receipt', gen: run.gen, seq: effect.seq, result: result.result, cause: result.cause, nativeReceiptId: null });
            return;
          case 'channel-lost': {
            // #552: one redelivery per row. A row that already lost a channel once fails on the second loss.
            const lostBefore = this.ports.store(sessionId).row(sessionId, effect.seq).failure !== null;
            this.send(sessionId, { k: 'receipt', gen: run.gen, seq: effect.seq, nativeReceiptId: null,
              result: lostBefore ? 'rejected-before-admission' : 'channel-lost', cause: result.cause });
            return;
          }
        }
        return;
      }
      case 'teardown':
        if (!run) throw new Error('Teardown has no lifecycle lease');
        run.unlisten?.(); run.unlisten = null;
        await run.adapter.teardown(effect.have, { gen: effect.gen });
        return;
      case 'mark-source-read': this.reconcileRead(sessionId, effect.seq); return;
      case 'report-failure': await this.ports.reportFailure(effect.seqs.map(seq => this.ports.store(sessionId).row(sessionId, seq)), effect.cause); return;
      case 'end-dependents': {
        // v3.1 #11 + 3d: side chats are fork entries of Life; their parent's end deletes each of them, all tried.
        const failures = (await Promise.allSettled(this.ports.forks(sessionId)
          .map(fork => this.interrupt(fork, { k: 'interrupt', reason: 'delete' })))).flatMap(r => r.status === 'rejected' ? [r.reason] : []);
        if (failures.length) throw new AggregateError(failures, `${failures.length} side chat(s) of session ${sessionId} did not end`);
        return;
      }
      case 'abort': case 'write-receipt': case 'write-hold': case 'remove': return;
      default: return assertNever(effect);
    }
  }

  /** A failed read marker leaves an accepted, unsettled row: a later cloud nudge reconciles it without dispatch. */
  reconcileRead(sessionId: string, seq: Seq): void {
    const row = this.ports.store(sessionId).row(sessionId, seq);
    if (row.state !== 'accepted') return;
    void this.ports.markRead(row).then(() => this.ports.store(sessionId).settleRead(sessionId, seq), error => this.ports.failed(sessionId, error));
  }

  private view(sessionId: string, entry: Entry): LifeView {
    const life = entry.life;
    const rows = this.ports.store(sessionId).unaccepted(sessionId);
    const hold = life.kind === 'dormant' || life.kind === 'failed' ? life.hold : life.kind === 'stopping' && life.destination.kind === 'held' ? life.destination.hold : null;
    return { sessionId, version: entry.version, kind: life.kind,
      stage: stageOf(entry),
      pending: { count: rows.filter(row => row.state === 'queued' || row.state === 'dispatching').length,
        items: rows.map(row => ({ seq: row.seq, messageId: row.message.id, preview: row.message.text.slice(0, 160), text: row.message.text, kind: row.kind,
          state: row.state, failure: row.state === 'failed' ? row.failure?.message ?? null : null })) },
      hold: hold?.reason ?? null,
      failure: life.kind === 'failed' ? { at: life.hold.reason === 'start-failed' ? life.hold.stage : null, message: life.hold.cause.message, cause: life.hold.cause } : null,
      lastExit: life.kind === 'dormant' ? life.lastExit?.cause.message ?? null : null,
      nativeSession: life.kind === 'ready' && entry.reconfigured ? life.have.channel.nativeSession : null };
  }

  private publish(sessionId: string, entry: Entry): void { entry.version += 1; this.ports.publish(this.view(sessionId, entry)); }
}

let installed: SessionLife | null = null;
export function installSessionLife(ports: SessionLifePorts): SessionLife {
  if (installed) throw new Error('Session lifecycle owner is already installed');
  installed = new SessionLife(ports);
  return installed;
}
export function sessionLife(): SessionLife {
  if (!installed) throw new Error('Session lifecycle owner is not installed');
  return installed;
}

function stageOf(entry: Entry): LifeView['stage'] {
  const life = entry.life;
  return life.kind === 'starting' ? { at: life.progress.at, index: STAGES.indexOf(life.progress.at) + 1, total: 7, since: entry.since } : null;
}

function assertNever(value: never): never { throw new Error(`Unhandled lifecycle effect: ${String(value)}`); }

async function runStage(run: Run, effect: RunStageEffect): Promise<StageResult> {
  const ctx = { gen: run.gen, signal: run.abort.signal };
  switch (effect.at) {
    case 'identity': return { at: effect.at, value: await run.adapter.run(effect.at, effect.have, ctx) };
    case 'workspace': return { at: effect.at, value: await run.adapter.run(effect.at, effect.have, ctx) };
    case 'capabilities': return { at: effect.at, value: await run.adapter.run(effect.at, effect.have, ctx) };
    case 'platform': return { at: effect.at, value: await run.adapter.run(effect.at, effect.have, ctx) };
    case 'cli': return { at: effect.at, value: await run.adapter.run(effect.at, effect.have, ctx) };
    case 'process': return { at: effect.at, value: await run.adapter.run(effect.at, effect.have, ctx) };
    case 'channel': return { at: effect.at, value: await run.adapter.run(effect.at, effect.have, ctx) };
    default: return assertNever(effect);
  }
}
