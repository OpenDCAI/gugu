import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectionHostIdentity } from '../../../../apps/desktop/electron/projection-host-identity';

const first = { ownerId: 'owner', deviceId: 'device', runtimeInstanceId: 'instance' };
const signal = () => new AbortController().signal;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());
describe('projection identity stamped by the real host boundary', () => {
  it('requires the current login to match a live runtime, without accepting request identity fields', async () => {
    for (const [auth, runtime] of [[null, first], [{ userId: 'other', accessToken: 'token' }, first],
      [{ userId: 'owner', accessToken: '' }, first], [{ userId: 'owner', accessToken: 'token' }, null]] as const) {
      const identity = createProjectionHostIdentity({ auth: async () => auth, runtime: () => runtime });
      try { await expect(identity.capture(signal())).rejects.toThrow(/matching authenticated runtime/); }
      finally { identity.dispose(); }
    }
  });
  it('stamps a copy and revokes synchronously for account changes and parent cancellation', async () => {
    const identity = createProjectionHostIdentity({ auth: async () => ({ userId: first.ownerId, accessToken: 'token' }), runtime: () => first });
    try {
      const lease = await identity.capture(signal()); expect(lease).toMatchObject(first);
      identity.invalidate(); expect(lease.signal.aborted).toBe(true); expect(() => lease.assertCurrent()).toThrow(/authentication changed/);
      const parent = new AbortController(), next = await identity.capture(parent.signal);
      const reason = new Error('Page detached'); parent.abort(reason);
      expect(next.signal.reason).toBe(reason); expect(() => next.assertCurrent()).toThrow('Page detached');
    } finally { identity.dispose(); }
  });
  it('cancels pending authentication immediately and never revives its late result', async () => {
    const auth = deferred<{ userId: string; accessToken: string }>();
    const identity = createProjectionHostIdentity({ auth: () => auth.promise, runtime: () => first });
    let settled = false;
    const pending = identity.capture(signal()).then(value => ({ value }), error => ({ error }));
    void pending.then(() => { settled = true; });
    try {
      identity.invalidate(); await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/authentication changed/) }) });
    } finally { auth.resolve({ userId: first.ownerId, accessToken: 'token' }); identity.dispose(); await pending; }
  });
  it.each(['ownerId', 'deviceId', 'runtimeInstanceId', 'expired'] as const)('rechecks %s at use and closes idle stale leases', async field => {
    vi.useFakeTimers();
    let current: typeof first | null = { ...first };
    const identity = createProjectionHostIdentity({ auth: async () => ({ userId: first.ownerId, accessToken: 'token' }), runtime: () => current });
    try {
      const immediate = await identity.capture(signal()), idle = await identity.capture(signal());
      current = field === 'expired' ? null : { ...first, [field]: 'changed' };
      expect(() => immediate.assertCurrent()).toThrow(/runtime changed/);
      expect(immediate.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1000); expect(idle.signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { identity.dispose(); }
  });
  it('releases its watcher when closed and refuses new leases after shutdown', async () => {
    vi.useFakeTimers();
    const identity = createProjectionHostIdentity({ auth: async () => ({ userId: first.ownerId, accessToken: 'token' }), runtime: () => first });
    const lease = await identity.capture(signal()); lease.release(); lease.release();
    expect(vi.getTimerCount()).toBe(0); identity.dispose();
    await expect(identity.capture(signal())).rejects.toThrow(/unavailable/);
  });
});
