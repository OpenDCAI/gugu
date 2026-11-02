import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import type { Gen, StageName, StageOut } from '@gugu/core/local/session-life/types';
import type { LegAdapter } from './session-life-adapter';
import { SessionLife } from './session-life';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mocks.db) throw new Error('Missing fixture'); return mocks.db; } }));
import { lifeStore } from './session-pending';

let fixture: Awaited<ReturnType<typeof openFixture>>;
let blocker: Database.Database;
beforeEach(async () => {
  fixture = await openFixture('empty'); mocks.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES ('p','P','/repo'); INSERT INTO sessions(id,project_id,title) VALUES ('s','p','S')");
  fixture.sqlite.pragma('busy_timeout=1');
  blocker = new Database(fixture.sqlite.name);
});
afterEach(() => { blocker.close(); fixture.close(); mocks.db = undefined; });

function lock() { blocker.exec("BEGIN IMMEDIATE; UPDATE projects SET name='locked' WHERE id='p'"); }
function rig() {
  let exit: Parameters<LegAdapter['onExit']>[1] | undefined;
  const run = vi.fn<(at: StageName) => void>();
  const dispatch = vi.fn<LegAdapter['dispatch']>(async () => ({ result: 'accepted', nativeReceiptId: 'native' }));
  const teardown = vi.fn<LegAdapter['teardown']>(async () => {});
  const failed = vi.fn();
  const store = { ...lifeStore, commit: vi.fn(lifeStore.commit) };
  const owner = new SessionLife({ sessions: () => ['s'], store: () => store,
    adapter: () => ({ leg: 'acp', timing: 'next-tool-call',
      async run<K extends StageName>(at: K, _have: unknown, ctx: { gen: Gen }): Promise<StageOut[K]> {
        run(at);
        return (at === 'identity' ? { kind: 'bound', agentUserId: 'agent' } : { at, gen: ctx.gen, timing: 'next-tool-call' }) as StageOut[K];
      }, dispatch, teardown,
      onExit: (_have, cb) => { exit = cb; return () => {}; } }),
    forks: () => [], allForks: () => [], parentOf: () => null, ownedBy: async () => true,
    markRead: async () => {}, reportFailure: async () => {}, publish: () => {}, removed: () => {}, failed, now: Date.now });
  return { owner, store, failed, run, dispatch, teardown, exit: () => exit!({ cause: { name: 'Exit', message: 'gone' }, code: 1, signal: null }),
    send: (id: string) => owner.enqueue({ sessionId: 's', messageId: id, text: id, kind: 'ordinary' }) };
}

it('keeps an accepted receipt through a same-process write transaction, then admits later events exactly once', async () => {
  const r = rig(); await r.owner.signIn('A');
  r.dispatch.mockImplementationOnce(async () => { lock(); return { result: 'accepted', nativeReceiptId: 'first' }; });
  const first = r.send('first'); const second = r.send('second');
  await vi.waitFor(() => expect(r.failed).toHaveBeenCalledTimes(1));
  expect(lifeStore.row('s', first.seq).state).toBe('dispatching');
  expect(r.dispatch).toHaveBeenCalledTimes(1);
  let drained = false;
  const draining = r.owner.quiescent('s').then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(drained).toBe(false);
  blocker.exec('COMMIT');
  await draining;
  expect([first, second].map(row => lifeStore.row('s', row.seq).state)).toEqual(['accepted', 'accepted']);
  expect(r.dispatch.mock.calls.map(call => call[1].message.id)).toEqual(['first', 'second']);
  r.send('third'); await r.owner.quiescent('s');
  expect(r.dispatch).toHaveBeenCalledTimes(3);
  await r.owner.signOut();
});

it('retries a stage decision after one BUSY without rerunning the completed stage', async () => {
  const r = rig(); await r.owner.signIn('A');
  const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' });
  let once = true;
  r.store.commit.mockImplementation((id, effects) => {
    if (once && effects.some(effect => effect.e === 'run-stage' && effect.at === 'workspace')) { once = false; throw busy; }
    lifeStore.commit(id, effects);
  });
  r.send('first'); await r.owner.quiescent('s');
  expect(r.owner.read('s').kind).toBe('ready');
  expect(r.run.mock.calls.map(call => call[0])).toEqual(['identity', 'workspace', 'capabilities', 'platform', 'cli', 'process', 'channel']);
  r.send('next'); await r.owner.quiescent('s');
  expect(r.dispatch).toHaveBeenCalledTimes(2);
  await r.owner.signOut();
});

it('recovers a fault commit after teardown fails under a lock, and the effect chain accepts a new start', async () => {
  const r = rig(); await r.owner.signIn('A'); r.owner.start('s'); await r.owner.quiescent('s');
  r.teardown.mockImplementationOnce(async () => { lock(); throw new Error('teardown failed'); });
  r.exit();
  await vi.waitFor(() => expect(r.failed).toHaveBeenCalledTimes(2));
  blocker.exec('COMMIT');
  await r.owner.quiescent('s');
  expect(r.owner.read('s')).toMatchObject({ kind: 'failed', failure: { message: 'teardown failed' } });
  r.owner.start('s'); await r.owner.quiescent('s');
  r.send('after-fault'); await r.owner.quiescent('s');
  expect(r.owner.read('s').kind).toBe('ready');
  expect(r.dispatch).toHaveBeenCalledTimes(1);
  await r.owner.signOut();
});

it('applies an interrupt queued behind a failed stage commit before running that stage', async () => {
  const r = rig(); await r.owner.signIn('A');
  let once = true;
  r.store.commit.mockImplementation((id, effects) => {
    if (once && effects.some(effect => effect.e === 'run-stage' && effect.at === 'workspace')) {
      once = false;
      throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    }
    lifeStore.commit(id, effects);
  });
  r.send('queued');
  // Let identity finish and queue its uncommitted stage-ok, without running the retry timer.
  for (let n = 0; n < 20 && !r.failed.mock.calls.length; n++) await Promise.resolve();
  expect(r.failed).toHaveBeenCalledTimes(1);
  await r.owner.interrupt('s', { k: 'interrupt', reason: 'user-stop' });
  expect(r.run.mock.calls.map(call => call[0])).toEqual(['identity']);
  expect(r.owner.read('s').kind).toBe('dormant');
  expect(r.dispatch).not.toHaveBeenCalled();
  await r.owner.signOut();
});

it('contains a permanent fault-commit failure without poisoning the next explicit start', async () => {
  const r = rig(); await r.owner.signIn('A'); r.owner.start('s'); await r.owner.quiescent('s');
  r.teardown.mockRejectedValueOnce(new Error('teardown failed'));
  let once = true;
  r.store.commit.mockImplementation((id, effects) => {
    if (once && effects.some(effect => effect.e === 'write-hold' && effect.hold?.reason === 'effect-fault')) { once = false; throw new Error('disk full'); }
    lifeStore.commit(id, effects);
  });
  r.exit(); await r.owner.quiescent('s');
  expect(r.failed.mock.calls.map(call => String(call[1]))).toEqual(['Error: teardown failed', 'Error: disk full']);
  r.owner.start('s'); await r.owner.quiescent('s');
  r.send('after-fault'); await r.owner.quiescent('s');
  expect(r.dispatch).toHaveBeenCalledTimes(1);
  await r.owner.signOut();
});
