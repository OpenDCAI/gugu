import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCaller } from './extension-bridge';
import { ExtensionProjections } from './extension-projections';
import { ProjectionMediaAccess } from './projection-media-access';
import { revokeExtensionProgramAccess } from './extension-program-access';

const principal = { extensionId: 'projection-media-access-test', sessionId: 'task-a', projectId: 'project-a' };
const page = (pageId = 10, sessionId = principal.sessionId) => ({
  extensionId: principal.extensionId, kind: 'page', pageId, binding: { workspace: `session:${sessionId}` },
}) as unknown as BridgeCaller;
function setup() {
  const authorize = vi.fn();
  const resources = new ExtensionProjections(authorize);
  const resource = resources.open(principal, { input: async () => {}, disconnect: async () => {}, refresh() {}, close() {} });
  const epochs = new Map<number, number>();
  const media = new ProjectionMediaAccess(resources, id => epochs.get(id) ?? 0);
  return { resources, resource, authorize, epochs, media };
}
afterEach(() => { revokeExtensionProgramAccess(principal.extensionId); });

describe('host page and real projection-resource media authority', () => {
  it('derives App/task/page/epoch from the host caller and rejects other scopes', async () => {
    const s = setup(); const caller = page();
    for (const wrong of [{ ...caller, kind: 'program' }, { ...caller, binding: null }, page(11, 'other-task'),
      { ...caller, extensionId: 'other-app' }]) {
      expect(() => s.media.open(wrong as BridgeCaller, s.resource.id)).toThrow();
    }
    const access = s.media.open(caller, s.resource.id);
    expect(access).toMatchObject({ extensionId: principal.extensionId, sessionId: 'task-a', pageId: 10, epoch: 0 });
    expect(Object.isFrozen(access)).toBe(true);
    access.release();
    expect(access.signal.aborted).toBe(true);
    expect(() => s.resources.sourceAccess(principal, s.resource.id)).not.toThrow();
    await s.resource.close();
  });

  it('rechecks a mutable host task binding before every use and invalidates only that page', async () => {
    const s = setup(); const caller = page(10);
    const a = s.media.open(caller, s.resource.id), b = s.media.open(page(11), s.resource.id);
    caller.binding!.workspace = 'session:other-task';
    expect(() => a.assertCurrent()).toThrow(/page binding changed/);
    expect(a.signal.aborted).toBe(true);
    expect(() => b.assertCurrent()).not.toThrow();
    b.release(); await s.resource.close();
  });

  it('invalidates on document epoch changes and synchronously closes an actual page scope', async () => {
    const s = setup();
    const a = s.media.open(page(10), s.resource.id), b = s.media.open(page(11), s.resource.id);
    s.epochs.set(10, 1);
    expect(() => a.assertCurrent()).toThrow(/page binding changed/);
    s.media.closePage(11);
    expect(b.signal.aborted).toBe(true);
    expect(() => b.assertCurrent()).toThrow();
    await s.resource.close();
  });

  it('uses the resource grant and task lifetime, never the device runtime lease', async () => {
    const s = setup();
    const access = s.media.open(page(), s.resource.id);
    s.authorize.mockImplementation(() => { throw new Error('App grant changed'); });
    expect(() => access.assertCurrent()).toThrow('App grant changed');
    expect(access.signal.aborted).toBe(true);
    s.authorize.mockReset();
    revokeExtensionProgramAccess(principal.extensionId);
    expect(access.signal.aborted).toBe(true);
    expect(() => access.assertCurrent()).toThrow();
    await s.resource.close();
  });

  it('bounds pending authority before capture starts and returns capacity on page or source closure', async () => {
    const s = setup();
    for (let index = 0; index < 16; index++) s.media.open(page(10), s.resource.id);
    expect(() => s.media.open(page(10), s.resource.id)).toThrow(/Too many/);
    s.media.closePage(10);
    const access = s.media.open(page(10), s.resource.id);
    await s.resource.close();
    expect(access.signal.aborted).toBe(true);
    const fresh = s.resources.open(principal, { input: async () => {}, disconnect: async () => {}, refresh() {}, close() {} });
    expect(() => s.media.open(page(10), fresh.id)).not.toThrow();
    await fresh.close();
  });
});
