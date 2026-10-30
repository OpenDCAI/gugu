import { describe, expect, it, vi } from 'vitest';
import { ProjectionMediaAccess } from './projection-media-access';
import { ExtensionProjections } from './extension-projections';

const principal = { extensionId: 'remote-app', sessionId: 'target-task' };
function setup() {
  let allowed = true;
  const authorize = vi.fn(() => { if (!allowed) throw new Error('App capability revoked'); });
  const resources = new ExtensionProjections(authorize);
  const source = resources.open(principal, { input: async () => {}, disconnect: async () => {}, close() {}, refresh() {} });
  const controller = new AbortController();
  const binding = { ...principal, pageId: 'rpc:fixture-page', epoch: '0', signal: controller.signal,
    assertCurrent: vi.fn(() => { controller.signal.throwIfAborted(); }) };
  const access = new ProjectionMediaAccess(resources, () => 999);
  return { access, source, binding, controller, revoke: () => { allowed = false; } };
}
describe('remote media uses host connection authority without forging a local page', () => {
  it('rechecks the exact App/task source and its capability on every use', async () => {
    const s = setup();
    try {
      for (const change of [{ extensionId: 'another-app' }, { sessionId: 'another-task' }]) {
        expect(() => s.access.openRemote({ ...s.binding, ...change }, s.source.id)).toThrow(/not in this App session/);
      }
      const lease = s.access.openRemote(s.binding, s.source.id);
      expect(lease).toMatchObject({ ...principal, pageId: 'rpc:fixture-page', epoch: '0' });
      lease.assertCurrent(); expect(s.binding.assertCurrent).toHaveBeenCalled();
      s.revoke(); expect(() => lease.assertCurrent()).toThrow(/capability revoked/);
      expect(lease.signal.aborted).toBe(true);
    } finally { await s.source.close(); }
  });
  it('revokes on connection loss and stale page metadata, without closing the owning source', async () => {
    for (const mode of ['detach', 'epoch', 'task'] as const) {
      const s = setup();
      try {
        const lease = s.access.openRemote(s.binding, s.source.id);
        if (mode === 'detach') s.controller.abort(new Error('Owner connection detached'));
        else if (mode === 'epoch') s.binding.epoch = '1';
        else s.binding.sessionId = 'other-task';
        expect(() => lease.assertCurrent()).toThrow(/detached|binding changed/);
        expect(lease.signal.aborted).toBe(true); expect(s.source.isClosing()).toBe(false);
      } finally { await s.source.close(); }
    }
  });
  it('shares the global pending-media limit and returns cancelled reservations', async () => {
    const s = setup();
    try {
      const leases = Array.from({ length: 64 }, (_, i) => s.access.openRemote({ ...s.binding, pageId: `rpc:${i}` }, s.source.id));
      expect(() => s.access.openRemote({ ...s.binding, pageId: 'rpc:overflow' }, s.source.id)).toThrow(/Too many/);
      s.controller.abort(new Error('Account changed')); expect(leases.every(lease => lease.signal.aborted)).toBe(true);
      const controller = new AbortController();
      const replacement = { ...s.binding, signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); } };
      s.access.openRemote(replacement, s.source.id).release();
    } finally { await s.source.close(); }
  });
});
