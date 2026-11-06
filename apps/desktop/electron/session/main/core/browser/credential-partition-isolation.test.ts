import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { app } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialPartitionIsolation } from './credential-partition-isolation';
import { assertCredentialAgentContents, assertCredentialNativeAdoption, credentialAgentPartitionBlocked, registerPrivateCredentialSurface } from './credential-isolation-registry';
import { createPageProtocol } from './page-protocol';
import type { CredentialUseBinding } from './credential-use-contract';

const native = vi.hoisted(() => ({ all: [] as WebContents[], owners: new Map<string, { sessionId: string; partition: string; contents: WebContents }>(),
  published: new Map<number, string>() }));
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return { app: new Emitter(), webContents: { getAllWebContents: () => native.all } };
});
vi.mock('./browser-webcontents-registry', () => ({ browserWebContentsRegistry: {
  isRegistered: (id: string, partition: string) => native.owners.get(id)?.partition === partition,
  isRegisteredForSession: (id: string, sessionId: string, partition: string) => {
    const owner = native.owners.get(id); return owner?.partition === partition && owner.sessionId === sessionId;
  },
  browsersOfSession: (sessionId: string) => [...native.owners.entries()].filter(([, owner]) => owner.sessionId === sessionId)
    .map(([browserId, owner]) => ({ browserId, webContents: owner.contents })),
  browserIdFor: (id: number) => native.published.get(id),
  registrationIdentity: (id: string) => native.owners.get(id),
} }));

let next = 0;
const boundaries: CredentialPartitionIsolation[] = [];
const releases: Array<() => void> = [];
function contents(nativeSession: object) {
  let destroyed = false, debuggerAttached = false, url = 'https://example.test/';
  const value = Object.assign(new EventEmitter(), { id: ++next,
    isDestroyed: () => destroyed, getURL: () => url,
    debugger: { isAttached: () => debuggerAttached },
    close: vi.fn(() => { if (destroyed) throw new Error('native access after destruction'); destroyed = true; value.emit('destroyed'); }),
  });
  // Catch the easy-to-miss native getter access after retiring a webContents.
  Object.defineProperty(value, 'session', { get() { if (destroyed) throw new Error('session after destruction'); return nativeSession; } });
  const wc = value as unknown as WebContents;
  native.all.push(wc); app.emit('web-contents-created', {}, wc);
  return { wc, close: value.close, attach: () => { debuggerAttached = true; }, url: (nextUrl: string) => { url = nextUrl; } };
}
function fixture() {
  const nativeSession = {}, source = contents(nativeSession), login = contents(nativeSession), suffix = String(++next);
  const binding: CredentialUseBinding = { accountId: 'owner', installationId: 'installation', agentId: 'agent', sessionId: 'session-' + suffix,
    browserId: 'tab-' + suffix, loginSurfaceId: 'private-' + suffix, loginSurfaceEpoch: 'epoch-' + suffix,
    requestId: 'request-' + suffix, useId: 'use-' + suffix, documentId: 'document', frameId: 'top-frame', formFingerprint: 'form',
    credentialId: 'credential', credentialVersion: '1', lockEpoch: 'lock', origin: 'https://example.test', operation: 'login-submit' };
  const partition = 'persist:credential-test-' + suffix;
  native.owners.set(binding.browserId, { sessionId: binding.sessionId, partition, contents: source.wc });
  const release = registerPrivateCredentialSurface({ ...binding, partition, contents: login.wc }); releases.push(release);
  return { binding, partition, nativeSession, source, login, release, prepare: async () => {
    const boundary = await CredentialPartitionIsolation.prepare(binding, source.wc); boundaries.push(boundary); return boundary;
  } };
}
afterEach(() => {
  for (const boundary of boundaries.splice(0)) boundary.invalidate();
  for (const wc of native.all) if (!wc.isDestroyed()) wc.close();
  for (const release of releases.splice(0)) release();
  native.all.length = 0; native.owners.clear(); native.published.clear();
});

describe('physical B partition isolation prototype', () => {
  it('keeps private contents permanently unavailable to the page protocol, even before isolation', () => {
    const f = fixture();
    expect(() => createPageProtocol(f.login.wc)).toThrow('credential_private_page_unavailable');
    expect(() => f.release()).toThrow('credential_private_surface_not_retired');
    f.login.wc.close(); f.release();
    expect(() => assertCredentialAgentContents(f.login.wc)).toThrow('credential_private_page_unavailable');
  });

  it('waits for actual source destruction and closes page admission before ready', async () => {
    const f = fixture(); f.source.close.mockImplementationOnce(() => {});
    const preparing = f.prepare();
    expect(credentialAgentPartitionBlocked(f.partition)).toBe(true);
    expect(() => assertCredentialAgentContents(f.source.wc)).toThrow('credential_partition_isolated');
    let ready = false; void preparing.then(() => { ready = true; });
    await Promise.resolve(); expect(ready).toBe(false);
    f.source.wc.close(); const boundary = await preparing;
    expect(f.source.wc.isDestroyed()).toBe(true);
    boundary.assertCurrent(f.binding);
  });

  it('refuses another live same-session page without closing it or releasing a secret', async () => {
    const f = fixture(), other = contents(f.nativeSession);
    await expect(f.prepare()).rejects.toThrow('credential_partition_has_other_pages');
    expect(other.close).not.toHaveBeenCalled(); expect(f.source.close).not.toHaveBeenCalled();
    expect(credentialAgentPartitionBlocked(f.partition)).toBe(false);
  });

  it('does not count a destroyed event alone as proof of actual retirement', async () => {
    const f = fixture(); f.source.close.mockImplementationOnce(() => { f.source.wc.emit('destroyed'); });
    await expect(f.prepare()).rejects.toThrow('credential_source_retirement_unconfirmed');
    expect(credentialAgentPartitionBlocked(f.partition)).toBe(false);
  });

  it('does not block pages in a different native session', async () => {
    const f = fixture(), boundary = await f.prepare(), other = contents({});
    expect(() => assertCredentialAgentContents(other.wc)).not.toThrow();
    boundary.assertCurrent(f.binding);
  });

  it('latches an unexpected same-session context and keeps admission closed after it disappears', async () => {
    const f = fixture(), boundary = await f.prepare(), other = contents(f.nativeSession);
    expect(boundary.signal.aborted).toBe(true); other.wc.close();
    expect(() => boundary.assertCurrent(f.binding)).toThrow('credential_isolation_unavailable');
    expect(credentialAgentPartitionBlocked(f.partition)).toBe(true);
  });

  it('latches an unexpected private destruction and a debugger attachment', async () => {
    const f = fixture(), boundary = await f.prepare(); f.login.attach();
    expect(() => boundary.assertCurrent(f.binding)).toThrow('credential_private_debugger_attached');
    expect(boundary.signal.aborted).toBe(true);
    const g = fixture(), second = await g.prepare(); g.login.wc.close();
    expect(second.signal.aborted).toBe(true);
  });

  it('latches changed destination ownership even if a later caller restores it', async () => {
    const f = fixture(), boundary = await f.prepare(), owner = native.owners.get(f.binding.browserId)!;
    native.owners.set(f.binding.browserId, { ...owner, sessionId: 'other-agent' });
    expect(() => boundary.assertCurrent(f.binding)).toThrow('credential_isolation_unavailable');
    native.owners.set(f.binding.browserId, owner);
    expect(() => boundary.assertCurrent(f.binding)).toThrow('credential_isolation_unavailable');
  });

  it('rejects closing and reopening the same tab registration with identical strings', async () => {
    const f = fixture(), boundary = await f.prepare(), owner = native.owners.get(f.binding.browserId)!;
    native.owners.set(f.binding.browserId, { ...owner });
    expect(() => boundary.assertCurrent(f.binding)).toThrow('credential_isolation_unavailable');
    expect(boundary.signal.aborted).toBe(true);
  });

  it.each(['origin', 'credentialVersion', 'accountId', 'lockEpoch', 'documentId', 'formFingerprint'] as const)(
    'rejects a mismatching %s before physical readiness is accepted', async key => {
      const f = fixture(), boundary = await f.prepare();
      expect(() => boundary.assertCurrent({ ...f.binding, [key]: 'changed' })).toThrow('credential_isolation_unavailable');
    },
  );

  it('keeps cleanup and prepared destination private until synchronous publication', async () => {
    const f = fixture(), boundary = await f.prepare(); boundary.beginCleanup(); f.login.wc.close(); f.release();
    const candidate = boundary.prepareCandidate(() => ({ webContents: contents(f.nativeSession).wc }));
    expect(() => assertCredentialAgentContents(candidate.webContents)).toThrow('credential_private_page_unavailable');
    boundary.publishCandidate(candidate.webContents, () => {
      expect(() => assertCredentialAgentContents(candidate.webContents)).toThrow();
      expect(() => createPageProtocol(candidate.webContents)).toThrow();
      expect(() => assertCredentialNativeAdoption(candidate.webContents)).not.toThrow();
      native.published.set(candidate.webContents.id, f.binding.browserId);
    });
    expect(credentialAgentPartitionBlocked(f.partition)).toBe(true);
    expect(() => assertCredentialAgentContents(candidate.webContents)).toThrow();
    boundary.confirmCandidate(candidate.webContents);
    expect(credentialAgentPartitionBlocked(f.partition)).toBe(false);
    expect(boundary.signal.aborted).toBe(false);
    expect(() => boundary.assertLifecycleCurrent(f.binding)).not.toThrow();
    expect(() => boundary.assertCurrent(f.binding)).toThrow('credential_isolation_unavailable');
    expect(() => boundary.assertLifecycleCurrent(f.binding)).not.toThrow();
  });

  it('retracts a pending registration synchronously and refuses a late confirmation', async () => {
    const f = fixture(), boundary = await f.prepare(); boundary.beginCleanup(); f.login.wc.close();
    const candidate = boundary.prepareCandidate(() => ({ webContents: contents(f.nativeSession).wc }));
    boundary.publishCandidate(candidate.webContents, () => { native.published.set(candidate.webContents.id, f.binding.browserId); });
    boundary.retractCandidate(candidate.webContents);
    expect(() => createPageProtocol(candidate.webContents)).toThrow();
    expect(() => boundary.confirmCandidate(candidate.webContents)).toThrow();
    expect(credentialAgentPartitionBlocked(f.partition)).toBe(true);
    expect(boundary.signal.aborted).toBe(true);
  });

  it.each(['async', 'wrong-owner', 'throw'])('retains a %s publication without reopening or exposing the candidate', async kind => {
    const f = fixture(), boundary = await f.prepare(); boundary.beginCleanup(); f.login.wc.close();
    const candidate = boundary.prepareCandidate(() => ({ webContents: contents(f.nativeSession).wc }));
    expect(() => boundary.publishCandidate(candidate.webContents, () => {
      if (kind === 'async') return Promise.reject(new Error('late')) as unknown as void;
      if (kind === 'throw') throw new Error('publish failed');
      native.published.set(candidate.webContents.id, 'wrong-tab');
    })).toThrow();
    expect(boundary.signal.aborted).toBe(true);
    expect(credentialAgentPartitionBlocked(f.partition)).toBe(true);
    expect(() => assertCredentialAgentContents(candidate.webContents)).toThrow('credential_private_page_unavailable');
  });

  it('refuses to publish a candidate that has navigated away from the exact HTTPS origin', async () => {
    const f = fixture(), boundary = await f.prepare(); boundary.beginCleanup(); f.login.wc.close();
    const candidate = boundary.prepareCandidate(() => { const view = contents(f.nativeSession); view.url('https://other.test/'); return { webContents: view.wc }; });
    const publish = vi.fn();
    expect(() => boundary.publishCandidate(candidate.webContents, publish)).toThrow();
    expect(publish).not.toHaveBeenCalled(); expect(credentialAgentPartitionBlocked(f.partition)).toBe(true);
    expect(boundary.signal.aborted).toBe(true);
  });
});
