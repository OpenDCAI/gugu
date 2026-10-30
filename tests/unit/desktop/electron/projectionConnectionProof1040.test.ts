import { describe, expect, it } from 'vitest';
import { createProjectionHostIdentity } from '../../../../apps/desktop/electron/projection-host-identity';
import { createProjectionConnectionProofs } from '../../../../apps/desktop/electron/projection-connection-proof';
const asker = (id = 'fixture-asker') => {
  const detached = new Set<() => void>();
  return { id, onDetached(callback: () => void) { detached.add(callback); return () => { detached.delete(callback); }; },
    detach() { for (const callback of [...detached]) callback(); }, count: () => detached.size };
};
const fixture = () => {
  const identity = createProjectionHostIdentity({ auth: async () => ({ userId: 'owner', accessToken: 'token' }),
    runtime: () => ({ ownerId: 'owner', deviceId: 'device', runtimeInstanceId: 'runtime' }) });
  const proofs = createProjectionConnectionProofs(identity);
  return { identity, proofs, close() { proofs.dispose(); identity.dispose(); } };
};
describe('projection private-channel read proof', () => {
  it('uses an unpredictable connection-bound proof and keeps identity out of caller fields', async () => {
    const f = fixture(), a = asker(), b = asker();
    try {
      const hello = await f.proofs.hello(a); expect(hello.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await f.proofs.hello(a)).toEqual(hello);
      const accepted = f.proofs.authorize(a, hello.proof);
      expect(accepted).toMatchObject({ ownerId: 'owner', deviceId: 'device', runtimeInstanceId: 'runtime', connectionId: hello.connectionId });
      await f.proofs.hello(b);
      for (const proof of [null, '', 'x'.repeat(43), hello.proof+'x', { proof: hello.proof }]) {
        expect(() => f.proofs.authorize(a, proof)).toThrow(/authentication/);
      }
      expect(() => f.proofs.authorize(b, hello.proof)).toThrow(/authentication/);
      expect(() => f.proofs.authorize(undefined, hello.proof)).toThrow(/authentication/);
      accepted.assertCurrent(); expect(accepted.signal.aborted).toBe(false);
    } finally { f.close(); }
  });
  it('revokes immediately on detach, account change and disposal and never accepts an old connection', async () => {
    const f = fixture(), a = asker();
    try {
      const first = await f.proofs.hello(a), lease = f.proofs.authorize(a, first.proof); a.detach();
      expect(lease.signal.aborted).toBe(true); expect(a.count()).toBe(0);
      const replacement = asker(a.id), next = await f.proofs.hello(replacement);
      expect(next.proof).not.toBe(first.proof); expect(() => f.proofs.authorize(replacement, first.proof)).toThrow(/authentication/);
      const second = f.proofs.authorize(replacement, next.proof); f.identity.invalidate();
      expect(second.signal.aborted).toBe(true); expect(() => second.assertCurrent()).toThrow(/authentication/);
      await f.proofs.hello(replacement); f.proofs.dispose();
      await expect(f.proofs.hello(replacement)).rejects.toThrow(/authentication/);
      expect(replacement.count()).toBe(0);
    } finally { f.close(); }
  });
  it('detaches while authentication is pending without leaving a proof or listener', async () => {
    let resolve!: (value: { userId: string; accessToken: string }) => void;
    const auth = new Promise<{ userId: string; accessToken: string }>(yes => { resolve = yes; });
    const identity = createProjectionHostIdentity({ auth: () => auth,
      runtime: () => ({ ownerId: 'owner', deviceId: 'device', runtimeInstanceId: 'runtime' }) });
    const proofs = createProjectionConnectionProofs(identity), a = asker();
    try {
      let settled = false;
      const pending = proofs.hello(a).then(value => ({ value }), error => ({ error }));
      void pending.then(() => { settled = true; });
      try {
        a.detach(); await new Promise(done => setImmediate(done)); expect(settled).toBe(true);
        expect(await pending).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/detached/) }) });
        expect(a.count()).toBe(0); expect(() => proofs.authorize(a, 'x'.repeat(43))).toThrow(/authentication/);
      } finally { resolve({ userId: 'owner', accessToken: 'token' }); proofs.dispose(); identity.dispose(); await pending; }
    } finally { proofs.dispose(); identity.dispose(); }
  });
});
