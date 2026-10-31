import assert from 'node:assert/strict';
import { SessionLife } from '../../../../apps/desktop/electron/session/main/core/sessions/session-life';
import type { LifeStore, SessionLifePorts } from '../../../../apps/desktop/electron/session/main/core/sessions/session-life';
import type { LegAdapter, PendingRow } from '../../../../apps/desktop/electron/session/main/core/sessions/session-life-adapter';
import { STAGES } from '../../../../packages/core/src/local/session-life/types';
import type { ExitFact, Gen, Hold, Seq, StageName, StageOut } from '../../../../packages/core/src/local/session-life/types';
import type { LifeView } from '../../../../apps/desktop/src/session/shared/core/sessions/session-life';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const seq = (value: number) => value as Seq;
const EXIT: ExitFact = { cause: { name: 'Lost', message: 'adapter exited' }, code: 1, signal: null };

function rig(options: { block?: StageName; delayReceipt?: boolean; dispatchThrowsOnce?: boolean; markReadFailsOnce?: boolean;
  failAt?: StageName; exitBeforeFail?: boolean; holdEndDependents?: Promise<void>; teardownThrowsOnce?: boolean; reportFailureThrowsOnce?: boolean; commitThrowsOnSignOutHold?: boolean } = {}) {
  const records = new Map<string, { owner: string | null; hold: Hold | null; archived: boolean }>();
  const rows = new Map<Seq, PendingRow>();
  const settled = new Set<Seq>();
  const active = new Set<object>();
  const views: LifeView[] = [];
  const removed: string[] = [];
  const dispatched: Seq[] = [];
  const failures: unknown[] = [];
  const marked: Seq[] = [];
  const trace: string[] = [];
  const blocked = deferred<void>();
  const dispatchStarted = deferred<void>();
  const receipt = deferred<{ result: 'accepted'; nativeReceiptId: string | null }>();
  const exitCallbacks: Array<(exit: ExitFact) => void> = [];
  let blockOnce = options.block;
  let throwOnce = options.dispatchThrowsOnce;
  let markFailOnce = options.markReadFailsOnce;
  let teardownThrows = options.teardownThrowsOnce;
  let reportThrows = options.reportFailureThrowsOnce;
  let commitThrows = options.commitThrowsOnSignOutHold;
  let counter = 0;
  const store: LifeStore = {
    sessions: () => [...records.keys()],
    read(id) { const record = records.get(id); assert.ok(record); return record; },
    pending(id) { const local = [...rows.values()].filter(row => row.sessionId === id).sort((a, b) => a.seq - b.seq);
      return { queued: local.filter(row => row.state === 'queued').map(row => row.seq), dispatching: local.filter(row => row.state === 'dispatching').map(row => row.seq) }; },
    row(id, s) { const row = rows.get(s); assert.ok(row && row.sessionId === id); return row; },
    rows(id) { return [...rows.values()].filter(row => row.sessionId === id).sort((a, b) => a.seq - b.seq); },
    enqueue(input) {
      const existing = [...rows.values()].find(row => row.sessionId === input.sessionId && row.message.id === input.messageId);
      if (existing) return { inserted: false, seq: existing.seq, state: existing.state };
      const s = seq(++counter);
      rows.set(s, { seq: s, sessionId: input.sessionId, kind: input.kind, state: 'queued', message: { id: input.messageId, text: input.text }, sources: [], turn: input.turn ?? { kind: 'prompt' } });
      return { inserted: true, seq: s, state: 'queued' };
    },
    commit(id, effects) {
      if (commitThrows && effects.some(e => e.e === 'write-hold' && e.hold?.reason === 'sign-out')) { commitThrows = false; throw new Error('disk full'); }
      for (const e of effects) {
      if (e.e === 'write-hold') records.get(id)!.hold = e.hold;
      if (e.e === 'write-receipt') { const row = rows.get(e.seq); assert.ok(row); rows.set(e.seq, { ...row, state: e.receipt.state }); }
    } },
    claim(id) { for (const row of rows.values()) if (row.sessionId === id && row.state === 'dispatching') rows.set(row.seq, { ...row, state: 'unknown' }); },
    acceptedUnsettled(id) { return [...rows.values()].filter(row => row.sessionId === id && row.state === 'accepted' && !settled.has(row.seq)).map(row => row.seq); },
    settleRead(_id, s) { settled.add(s); },
    remove(id) { records.delete(id); for (const row of rows.values()) if (row.sessionId === id) rows.delete(row.seq); },
  };
  const ports: SessionLifePorts = { store, ownedBy: async (id, user) => records.get(id)?.owner === user,
    adapter() {
      return { leg: 'acp', timing: 'next-tool-call',
        async run<K extends StageName>(at: K, _have: unknown, ctx: { gen: Gen; signal: AbortSignal }): Promise<StageOut[K]> {
          ctx.signal.throwIfAborted();
          trace.push(`stage:${ctx.gen.attempt}:${at}`);
          if (options.failAt === at) {
            if (options.exitBeforeFail) exitCallbacks.at(-1)!(EXIT);
            throw new Error(`${at} unavailable`);
          }
          if (blockOnce === at) {
            blockOnce = undefined;
            blocked.resolve();
            await new Promise<void>((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
          }
          const lease = { at, gen: ctx.gen, timing: 'next-tool-call' };
          if (at !== 'identity' && at !== 'channel') active.add(lease);
          return (at === 'identity' ? { kind: 'bound', agentUserId: 'agent' } : lease) as StageOut[K];
        },
        async dispatch(_have, row) { dispatched.push(row.seq); dispatchStarted.resolve();
          if (throwOnce) { throwOnce = false; throw new Error('worker RPC failed'); } return options.delayReceipt ? receipt.promise : { result: 'accepted', nativeReceiptId: row.message.id }; },
        async teardown(have) { trace.push('teardown'); if (teardownThrows) { teardownThrows = false; throw new Error('teardown failed'); } for (const lease of Object.values(have)) active.delete(lease); },
        onExit(_have, cb) { exitCallbacks.push(cb); return () => { trace.push('unlisten'); }; },
        async endDependents() { trace.push('end-dependents'); if (options.holdEndDependents) await options.holdEndDependents; trace.push('end-dependents-done'); },
      } satisfies LegAdapter;
    },
    markRead: async row => { if (markFailOnce) { markFailOnce = false; throw new Error('read marker failed'); } marked.push(row.seq); }, reportFailure: async (_rows, cause) => { if (reportThrows) { reportThrows = false; throw new Error('report failed'); } trace.push(`failure:${cause.name}`); },
    publish: view => { views.push(view); }, removed: id => { removed.push(id); }, failed: (_id, error) => { failures.push(error); }, now: () => 1234,
  };
  const owner = new SessionLife(ports);
  function session(id = 's', account: string | null = 'A') { records.set(id, { owner: account, hold: null, archived: false }); }
  function enqueue(id = 's') { const s = seq(++counter); rows.set(s, { seq: s, sessionId: id, kind: 'ordinary', state: 'queued', message: { id: `m${s}`, text: `input ${s}` }, sources: [], turn: { kind: 'prompt' } }); return s; }
  const send = (id = 's', messageId = `user-${++counter}`) => owner.enqueue({ sessionId: id, messageId, text: messageId, kind: 'ordinary' });
  return { owner, records, rows, active, views, removed, dispatched, failures, marked, trace, blocked, dispatchStarted, receipt, exitCallbacks, session, enqueue, send, store };
}

export const ownerCases: readonly { name: string; run: () => Promise<void> }[] = [
  { name: 'one owner completes seven stages and admits the durable queue in order', async run() {
    const r = rig(); r.session(); const first = r.enqueue(); const second = r.enqueue();
    await r.owner.signIn('A'); await r.owner.quiescent('s');
    assert.deepEqual(r.dispatched, [first, second]);
    assert.deepEqual(r.marked, [first, second]);
    assert.equal(r.trace.filter(line => line.startsWith('stage:')).length, 7);
    assert.equal(r.owner.read('s').kind, 'ready');
    assert.equal(r.owner.read('s').pending.count, 0);
    assert.deepEqual(r.failures, []);
    await r.owner.signOut(); assert.equal(r.active.size, 0);
  } },
  { name: 'stopping at every stage releases leases and a new delivery starts a new attempt', async run() {
    for (const at of STAGES) {
      const r = rig({ block: at }); r.session(); const old = r.enqueue();
      await r.owner.signIn('A'); await r.blocked.promise;
      await r.owner.interrupt('s', { k: 'interrupt', reason: 'user-stop' });
      assert.equal(r.owner.read('s').kind, 'dormant');
      assert.deepEqual(r.records.get('s')!.hold, { reason: 'user-stop', barrier: old });
      assert.equal(r.active.size, 0, at);
      assert.deepEqual(r.dispatched, [], at);
      const { seq: fresh } = await r.send(); await r.owner.quiescent('s');
      assert.deepEqual(r.dispatched, [old, fresh], at);
      assert.equal(r.trace.filter(line => line.endsWith(':identity')).length, 2);
      assert.deepEqual(r.failures, [], at);
      await r.owner.signOut(); assert.equal(r.active.size, 0);
    }
  } },
  { name: 'sign-out accepts a late old-epoch receipt before teardown and never starts it for another account', async run() {
    const r = rig({ delayReceipt: true }); r.session(); const message = r.enqueue();
    await r.owner.signIn('A'); await r.dispatchStarted.promise;
    const signingOut = r.owner.signOut();
    assert.equal(r.owner.read('s').kind, 'stopping');
    r.receipt.resolve({ result: 'accepted', nativeReceiptId: 'native' });
    await signingOut;
    assert.equal(r.rows.get(message)!.state, 'accepted');
    assert.deepEqual(r.marked, [message]);
    assert.equal(r.active.size, 0);
    const before = r.trace.length;
    await r.owner.signIn('B');
    r.exitCallbacks[0]!(EXIT);
    assert.equal(r.trace.length, before);
    assert.deepEqual(r.dispatched, [message]);
    assert.deepEqual(r.failures, []);
  } },
  { name: 'an empty ready exit tears down every lease without restarting', async run() {
    const r = rig(); r.session(); await r.owner.signIn('A'); r.owner.start('s'); await r.owner.quiescent('s');
    r.exitCallbacks[0]!(EXIT); await r.owner.quiescent('s');
    assert.equal(r.owner.read('s').kind, 'dormant'); assert.equal(r.active.size, 0);
    assert.equal(r.trace.filter(line => line.endsWith(':identity')).length, 1);
    assert.equal(r.owner.read('s').lastExit, 'adapter exited');
    assert.deepEqual(r.failures, []);
  } },
  { name: 'archive and delete end the dependents; delete still runs its IO and interrupt waits for it', async run() {
    for (const reason of ['archive', 'delete'] as const) {
      const r = rig(); r.session(); await r.owner.signIn('A'); r.owner.start('s'); await r.owner.quiescent('s');
      await r.owner.interrupt('s', { k: 'interrupt', reason });
      assert.equal(r.active.size, 0, reason);
      assert.deepEqual(r.trace.filter(line => line === 'teardown' || line === 'end-dependents'), ['teardown', 'end-dependents'], reason);
      assert.deepEqual(r.failures, []);
    }
    const r = rig(); r.session(); await r.owner.signIn('A');
    await r.owner.interrupt('s', { k: 'interrupt', reason: 'delete' });
    assert.deepEqual(r.trace, ['end-dependents', 'end-dependents-done']); assert.deepEqual(r.removed, ['s']);
  } },
  { name: 'a session id re-created right after delete starts only after the deleted entry finished its IO', async run() {
    const held = deferred<void>();
    const r = rig({ holdEndDependents: held.promise }); r.session(); await r.owner.signIn('A'); r.owner.start('s');
    await r.owner.quiescent('s');
    const deleting = r.owner.interrupt('s', { k: 'interrupt', reason: 'delete' });
    while (!r.removed.includes('s')) await new Promise(resolve => setTimeout(resolve, 0));
    r.session(); r.owner.start('s');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(r.trace.filter(line => line.endsWith(':identity')).length, 1);
    held.resolve(); await deleting; await r.owner.quiescent('s');
    const done = r.trace.indexOf('end-dependents-done'); const second = r.trace.lastIndexOf('stage:1:identity');
    assert.ok(done >= 0 && second > done, JSON.stringify(r.trace));
    assert.equal(r.owner.read('s').kind, 'ready'); assert.deepEqual(r.failures, []);
  } },
  { name: 'delete removes the actor without publishing an archived projection', async run() {
    const r = rig(); r.session(); await r.owner.signIn('A'); r.owner.start('s'); await r.owner.quiescent('s');
    const before = r.views.length;
    await r.owner.interrupt('s', { k: 'interrupt', reason: 'delete' });
    assert.deepEqual(r.removed, ['s']); assert.equal(r.active.size, 0);
    assert.equal(r.views.slice(before).some(view => view.kind === 'archived'), false);
    assert.equal(r.records.has('s'), false); assert.deepEqual(r.failures, []);
  } },
  { name: 'hydrate excludes unknown/foreign bindings and a projection read cannot enroll them', async run() {
    const r = rig(); r.session('unknown', null); r.session('foreign', 'B'); r.enqueue('unknown'); r.enqueue('foreign');
    await r.owner.signIn('A');
    assert.equal(r.owner.read('unknown').kind, 'dormant');
    assert.equal(r.owner.read('foreign').kind, 'dormant');
    await r.owner.signOut();
    assert.deepEqual(r.dispatched, []); assert.deepEqual(r.trace, []);
    assert.equal(r.records.get('unknown')!.hold, null); assert.equal(r.records.get('foreign')!.hold, null);
  } },
  { name: 'a live insert into an unbound session starts it and identity binds (v3.1 #8)', async run() {
    const r = rig(); r.session('unknown', null); const old = r.enqueue('unknown');
    await r.owner.signIn('A');
    const { seq: fresh } = r.send('unknown'); await r.owner.quiescent('unknown');
    assert.deepEqual(r.dispatched, [old, fresh]); assert.equal(r.owner.read('unknown').kind, 'ready');
    assert.deepEqual(r.failures, []);
    await r.owner.signOut();
  } },
  { name: 'nothing starts while signing out: a delivery is held loudly and its row stays queued (v3.1 #7)', async run() {
    const r = rig({ delayReceipt: true }); r.session(); r.session('other'); await r.owner.signIn('A');
    r.send(); await r.dispatchStarted.promise;
    const leaving = r.owner.signOut();
    const { seq: late } = r.send('other');
    assert.throws(() => r.owner.start('other'), /Sign-out is in progress/);
    r.receipt.resolve({ result: 'accepted', nativeReceiptId: null }); await leaving;
    assert.equal(r.rows.get(late)!.state, 'queued'); assert.equal(r.owner.read('other').kind, 'dormant');
    assert.equal(r.failures.length, 1); assert.match(String(r.failures[0]), /sign-out is in progress/);
  } },
  { name: 'auth transitions are ordered: a sign-in requested after another never interleaves with it', async run() {
    const r = rig(); r.session('a', 'A'); r.session('b', 'B'); const forA = r.enqueue('a'); const forB = r.enqueue('b');
    const first = r.owner.signIn('A'); const second = r.owner.signIn('B');
    await Promise.all([first, second]); await r.owner.quiescent('b');
    // B's sign-in interrupts A's start before admission: A's row waits under A's sign-out hold.
    assert.deepEqual(r.dispatched, [forB]); assert.equal(r.rows.get(forA)!.state, 'queued');
    assert.equal(r.owner.read('a').kind, 'dormant'); assert.equal(r.records.get('a')!.hold?.reason, 'sign-out');
    assert.equal(r.owner.read('b').kind, 'ready'); assert.equal(r.active.size > 0, true);
    assert.deepEqual(r.failures, []);
    await r.owner.signOut(); assert.equal(r.active.size, 0);
  } },
  { name: 'a thrown dispatch is an exit: the row becomes unknown, is never replayed, and the next row restarts', async run() {
    const r = rig({ dispatchThrowsOnce: true }); r.session(); await r.owner.signIn('A');
    const { seq: lost } = await r.send(); const { seq: next } = await r.send();
    await r.owner.quiescent('s');
    assert.equal(r.rows.get(lost)!.state, 'unknown');
    assert.equal(r.rows.get(next)!.state, 'accepted');
    assert.deepEqual(r.dispatched, [lost, next]);
    assert.equal(r.trace.filter(line => line.endsWith(':identity')).length, 2);
    assert.equal(r.active.size > 0, true); assert.deepEqual(r.failures, []);
    await r.owner.signOut(); assert.equal(r.active.size, 0);
  } },
  { name: 'three concurrent auth transitions run in request order, even one requested between two others', async run() {
    const r = rig(); r.session('a', 'A'); r.session('b', 'B'); r.session('c', 'C'); r.enqueue('a'); r.enqueue('b'); r.enqueue('c');
    let third: Promise<void> | null = null;
    const first = r.owner.signIn('A').then(() => { third = r.owner.signIn('C'); });
    const second = r.owner.signIn('B');
    await first; await second; await third; await r.owner.quiescent('c');
    assert.equal(r.records.get('a')!.hold?.reason, 'sign-out'); assert.equal(r.records.get('b')!.hold?.reason, 'sign-out');
    const bHold = r.records.get('b')!.hold; assert.ok(bHold?.reason === 'sign-out' && bHold.ownerUserId === 'B');
    assert.equal(r.owner.read('c').kind, 'ready'); assert.deepEqual(r.failures, []);
    await r.owner.signOut(); assert.equal(r.active.size, 0);
  } },
  { name: 'a thrown dispatch then the dead run reporting its own exit restarts once; the stale exit drops', async run() {
    const r = rig({ dispatchThrowsOnce: true }); r.session(); await r.owner.signIn('A');
    const { seq: lost } = r.send(); await r.owner.quiescent('s');
    r.exitCallbacks[0]!(EXIT); await r.owner.quiescent('s');
    const { seq: next } = r.send(); await r.owner.quiescent('s');
    assert.equal(r.rows.get(lost)!.state, 'unknown'); assert.equal(r.rows.get(next)!.state, 'accepted');
    // The throw empties the queue (dormant, no restart); the stale exit drops; only the next row starts attempt 2.
    assert.equal(r.trace.filter(line => line.endsWith(':identity')).length, 2);
    assert.deepEqual(r.failures, []);
    await r.owner.signOut(); assert.equal(r.active.size, 0);
  } },
  { name: 'v3.1 #9: a throwing teardown on ready×exit fails the session instead of leaving it starting; retry tears down first', async run() {
    const r = rig({ teardownThrowsOnce: true }); r.session(); await r.owner.signIn('A'); r.owner.start('s'); await r.owner.quiescent('s');
    const leases = r.active.size; assert.ok(leases > 0);
    r.exitCallbacks[0]!(EXIT); await r.owner.quiescent('s');
    const view = r.owner.read('s'); assert.equal(view.kind, 'failed'); assert.deepEqual(view.failure, { at: null, message: 'teardown failed' });
    assert.equal(r.records.get('s')!.hold?.reason, 'effect-fault'); assert.equal(r.failures.length, 1);
    r.owner.start('s'); await r.owner.quiescent('s');
    assert.equal(r.owner.read('s').kind, 'ready'); assert.equal(r.active.size, leases);
    await r.owner.signOut(); assert.equal(r.active.size, 0);
  } },
  { name: 'v3.1 #9: a throwing report-failure stops the batch: no settled, the never-sent row stays queued', async run() {
    const r = rig({ failAt: 'platform', reportFailureThrowsOnce: true }); r.session(); await r.owner.signIn('A');
    const { seq: row } = r.send(); await r.owner.quiescent('s');
    const view = r.owner.read('s'); assert.equal(view.kind, 'failed'); assert.equal(view.failure?.at, null);
    assert.equal(r.rows.get(row)!.state, 'queued'); assert.deepEqual(r.dispatched, []);
    assert.equal(r.active.size, 0); assert.equal(r.failures.length, 1);
  } },
  { name: 'a channel failure racing the exit keeps the first fact: the exit cause becomes the failure hold', async run() {
    const r = rig({ failAt: 'channel', exitBeforeFail: true }); r.session(); await r.owner.signIn('A');
    r.send(); await r.owner.quiescent('s');
    const hold = r.records.get('s')!.hold;
    assert.ok(hold?.reason === 'start-failed'); assert.equal(hold.stage, 'channel'); assert.equal(hold.cause.message, 'adapter exited');
    assert.equal(r.owner.read('s').kind, 'failed'); assert.equal(r.active.size, 0); assert.deepEqual(r.failures, []);
  } },
  { name: 'v3.1 #10: a failed leave keeps the epoch and account and reopens starts; the caller can retry', async run() {
    const r = rig({ commitThrowsOnSignOutHold: true }); r.session(); r.enqueue(); await r.owner.signIn('A'); await r.owner.quiescent('s');
    await r.owner.interrupt('s', { k: 'interrupt', reason: 'user-stop' });
    await assert.rejects(r.owner.signOut(), /disk full/);
    r.owner.start('s'); await r.owner.quiescent('s'); assert.equal(r.owner.read('s').kind, 'ready');
    await r.owner.signOut(); assert.equal(r.records.get('s')!.hold?.reason, 'sign-out'); assert.equal(r.active.size, 0);
  } },
  { name: 'a refetched duplicate of an accepted row retries its failed read marker without dispatching again', async run() {
    const r = rig({ markReadFailsOnce: true }); r.session(); await r.owner.signIn('A');
    const { seq: message } = await r.send('s', 'cloud-1'); await r.owner.quiescent('s');
    assert.deepEqual(r.marked, []); assert.equal(r.failures.length, 1);
    const again = await r.owner.enqueue({ sessionId: 's', messageId: 'cloud-1', text: 'cloud-1', kind: 'ordinary' });
    assert.deepEqual(again, { seq: message, state: 'accepted' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(r.marked, [message]); assert.deepEqual(r.dispatched, [message]);
    await r.owner.signOut();
  } },
];

export async function verifyOwnerCases(): Promise<void> { for (const c of ownerCases) await c.run(); }
