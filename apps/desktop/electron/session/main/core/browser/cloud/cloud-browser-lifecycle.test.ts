vi.mock('../../asks', () => import('../../../../../../../../tests/support/ask-service'));
vi.mock('../../asks/ask', () => import('../../../../../../../../tests/support/ask-service'));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const fixture = vi.hoisted(() => ({ launches: [] as Array<{ exit: (reason: string) => void; kill: ReturnType<typeof vi.fn>; finish: () => void }>, hubs: [] as FakeHub[], holdExit: false }));

type Target = { targetId: string; type: string; title: string; url: string };
class FakeHub {
  closed = false;
  closesSuccessfully = true;
  readonly targets = new Map<string, Target>([['blank', { targetId: 'blank', type: 'page', title: '', url: 'about:blank' }]]);
  private listeners = new Set<(event: { method: string; params: Record<string, unknown> }) => void>();
  private closers = new Set<(reason: string) => void>();
  readonly send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'Target.getTargets') return { targetInfos: [...this.targets.values()] };
    if (method === 'Target.createTarget') {
      const targetId = `tab-${this.targets.size}`;
      this.targets.set(targetId, { targetId, type: 'page', title: '', url: 'about:blank' });
      return { targetId };
    }
    if (method === 'Target.closeTarget' && this.closesSuccessfully) {
      this.targets.delete(String(params.targetId));
      for (const listener of this.listeners) listener({ method: 'Target.targetDestroyed', params });
    }
    return { success: this.closesSuccessfully };
  });
  onEvent(listener: (event: { method: string; params: Record<string, unknown> }) => void) {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  onClose(listener: (reason: string) => void) {
    this.closers.add(listener); return () => this.closers.delete(listener);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closers) listener('closed');
  }
}

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/browser-lifecycle' }, safeStorage: {} }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { on: vi.fn() } }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: async () => null }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('./chrome', () => ({
  findChrome: () => '/test/chrome',
  openDisplay: async () => ({ display: null, stop: () => {} }),
  launchChrome: async ({ onExit }: { onExit: (reason: string) => void }) => {
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null });
    const finish = () => { child.exitCode = 0; child.emit('exit'); onExit('fixture Chrome exited'); };
    const kill = vi.fn(() => { if (!fixture.holdExit) queueMicrotask(finish); return true; });
    fixture.launches.push({ exit: onExit, kill, finish });
    return { child: Object.assign(child, { kill }), browserUrl: 'ws://test', port: 1, headless: true };
  },
}));
vi.mock('./cdp-hub', () => ({ CdpHub: { connect: async () => {
  const hub = new FakeHub(); fixture.hubs.push(hub); return hub;
} } }));

import { CloudBrowser } from './cloud-browser';

describe('cloud browser task ownership', () => {
  let browser: CloudBrowser;
  beforeEach(() => {
    fixture.launches = [];
    fixture.hubs = [];
    fixture.holdExit = false;
    browser = new CloudBrowser({}, '/tmp/browser-lifecycle');
  });
  afterEach(() => browser.shutdown());

  it('releases exactly one owner page, then shuts Chrome down when the last owner is released', async () => {
    await browser.openTransport('one');
    await browser.openTransport('two');
    expect(browser.sessionIds()).toEqual(['one', 'two']);
    await browser.closeSession('one');
    expect(browser.sessionIds()).toEqual(['two']);
    expect(browser.status(null).running).toBe(true);
    expect(fixture.launches[0]!.kill).not.toHaveBeenCalled();
    await browser.closeSession('two');
    expect(browser.status(null)).toMatchObject({ running: false, tabs: [] });
    expect(fixture.launches[0]!.kill).toHaveBeenCalledOnce();
  });

  it('retains an owner when Chrome refuses its page close', async () => {
    await browser.openTransport('one');
    fixture.hubs[0]!.closesSuccessfully = false;
    await expect(browser.closeSession('one')).rejects.toThrow('Chrome did not close');
    expect(browser.sessionIds()).toEqual(['one']);
    expect(fixture.launches[0]!.kill).not.toHaveBeenCalled();
  });

  it('opens a fresh page after reclamation and ignores the previous Chrome process exit', async () => {
    await browser.openTransport('one');
    await browser.closeSession('one');
    await browser.openTransport('one');
    fixture.launches[0]!.exit('previous Chrome finally exited');
    expect(browser.status(null).running).toBe(true);
    expect(browser.sessionIds()).toEqual(['one']);
    expect(fixture.launches[1]!.kill).not.toHaveBeenCalled();
  });

  it('protects an outstanding browser call or human takeover from idle reclamation', async () => {
    expect(browser.sessionInUse('one')).toBe(false);
    browser.toolStarting('one');
    expect(browser.sessionInUse('one')).toBe(true);
    browser.toolFinished('one');
    expect(browser.sessionInUse('one')).toBe(false);
    browser.acquireControl('person');
    expect(browser.sessionInUse('one')).toBe(true);
    await browser.releaseControl('person');
    expect(browser.sessionInUse('one')).toBe(false);
  });

  it('does not start another Chrome on the same profile until the released process has exited', async () => {
    await browser.openTransport('one');
    fixture.holdExit = true;
    const releasing = browser.closeSession('one');
    await vi.waitFor(() => expect(fixture.launches[0]!.kill).toHaveBeenCalledOnce());
    const opening = browser.openTransport('two');
    await Promise.resolve();
    expect(fixture.launches).toHaveLength(1);
    fixture.holdExit = false;
    fixture.launches[0]!.finish();
    await Promise.all([releasing, opening]);
    expect(fixture.launches).toHaveLength(2);
    expect(browser.status(null).running).toBe(true);
  });
});
