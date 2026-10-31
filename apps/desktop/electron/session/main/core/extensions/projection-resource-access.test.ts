import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionProjections, type ProjectionSource } from './extension-projections';
import { revokeExtensionProgramAccess } from './extension-program-access';
import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';

const principal = { extensionId: 'projection-resource-access-test', sessionId: 'task-a', projectId: 'project-a' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};
function setup(overrides: Partial<ProjectionSource> = {}) {
  const authorize = vi.fn();
  const resources = new ExtensionProjections(authorize);
  const source: ProjectionSource = {
    input: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), refresh: vi.fn(), close: vi.fn(), ...overrides,
  };
  const resource = resources.open(principal, source);
  return { authorize, resources, resource, source };
}
function wire() {
  const packets: ProjectionHostPacket[] = [];
  return { transport: 'local' as const, packets, send: (packet: ProjectionHostPacket) => { packets.push(packet); }, onClose: () => () => {} };
}
afterEach(() => { revokeExtensionProgramAccess(principal.extensionId); });

describe('host resource access for the direct-media authority adapter', () => {
  it('requires the real source in the exact App/task and snapshots its principal', async () => {
    const s = setup();
    for (const wrong of [{ ...principal, extensionId: 'other-app' }, { ...principal, sessionId: 'other-task' }]) {
      expect(() => s.resources.sourceAccess(wrong, s.resource.id)).toThrow(/not in this App session/);
    }
    expect(() => s.resources.sourceAccess(principal, 'unknown')).toThrow(/not in this App session/);
    const mutable = { ...principal };
    const access = s.resources.sourceAccess(mutable, s.resource.id);
    mutable.sessionId = 'other-task';
    access.assertCurrent();
    expect(s.authorize).toHaveBeenLastCalledWith(principal);
    expect(s.source.refresh).not.toHaveBeenCalled();
    await s.resource.close();
    expect(access.signal.aborted).toBe(true);
    expect(() => access.assertCurrent()).toThrow();
  });

  it('rechecks current grants and synchronously observes real App-wide revocation', async () => {
    const s = setup();
    const access = s.resources.sourceAccess(principal, s.resource.id);
    s.authorize.mockImplementation(() => { throw new Error('grant withdrawn'); });
    expect(() => access.assertCurrent()).toThrow('grant withdrawn');
    s.authorize.mockReset();
    revokeExtensionProgramAccess(principal.extensionId);
    expect(access.signal.aborted).toBe(true);
    expect(() => access.assertCurrent()).toThrow();
    await s.resource.close();
  });

  it.each([{ sessionId: principal.sessionId }, { projectId: principal.projectId }])('invalidates the source access when its host closes scope %j', async scope => {
    const s = setup();
    const access = s.resources.sourceAccess(principal, s.resource.id);
    s.resources.closeScope(scope);
    expect(access.signal.aborted).toBe(true);
    expect(() => access.assertCurrent()).toThrow();
    await s.resource.close();
  });

  it('disconnect waits for in-flight input and held-key cleanup, while the source survives', async () => {
    const entered = deferred(), finish = deferred(), cleanup = deferred();
    let held = false;
    const s = setup({ input: async () => { held = true; entered.resolve(); await finish.promise; },
      disconnect: async () => { await cleanup.promise; held = false; } });
    const connection = wire();
    const viewer = s.resources.connect(principal, s.resource.id, connection);
    s.resource.publish({ sequence: 1, width: 128, height: 96, mime: 'image/png', data: 'YQ==' });
    const generation = connection.packets[0]!.generation;
    await viewer.receive({ type: 'ack', generation, frame: 1 });
    const input = viewer.receive({ type: 'input', generation, frame: 1, sequence: 1,
      input: { kind: 'key', action: 'down', key: 'Shift' } }).catch(() => undefined);
    await entered.promise;
    let disconnected = false;
    const stopped = viewer.disconnect().then(() => { disconnected = true; });
    await Promise.resolve();
    expect(disconnected).toBe(false);
    expect(held).toBe(true);
    finish.resolve();
    await input;
    await Promise.resolve();
    expect(disconnected).toBe(false);
    cleanup.resolve();
    await stopped;
    expect(held).toBe(false);
    expect(s.source.close).not.toHaveBeenCalled();
    expect(() => s.resources.sourceAccess(principal, s.resource.id)).not.toThrow();
    await s.resource.close();
  });

  it('disconnect surfaces cleanup failure instead of releasing an apparently clean media lease', async () => {
    const s = setup({ disconnect: async () => { throw new Error('native cleanup failed'); } });
    const viewer = s.resources.connect(principal, s.resource.id, wire());
    await expect(viewer.disconnect()).rejects.toThrow('native cleanup failed');
    await s.resource.close();
  });
});
