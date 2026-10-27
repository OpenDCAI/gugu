import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/gugu-cloud-browser-test' }, safeStorage: {} }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { on: vi.fn(), reportHostWait: vi.fn() } }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: vi.fn(async () => null) }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { CloudBrowser, STOPPED_MESSAGE } from './cloud-browser';

/**
 * What the agent is told when it asks the person for a step in the browser (#7199): taken over and handed back,
 * declined, not answered in time, stopped, the browser gone, replaced by another ask, the agent's call gone.
 * These outcomes must not change when the ask moves onto the session's Ask queue. The person's two gestures
 * reach the browser differently before and after that move; only `person` below knows how.
 */
const person = {
  pendingId: (b: CloudBrowser): string | undefined => b.status(null).assistance?.requestId,
  decline: (b: CloudBrowser, requestId: string) => b.dismissAssistance(requestId),
};

const TEN_MINUTES = 10 * 60_000;

function browserWithTab(...sessionIds: string[]) {
  const b = new CloudBrowser({ PATH: '' }, '/tmp/gugu-cloud-browser-test');
  const tabs = (b as unknown as { sessionTab: Map<string, string> }).sessionTab;
  sessionIds.forEach((id, i) => tabs.set(id, `tab-${i + 1}`));
  return b;
}

const settled = async <T>(promise: Promise<T>): Promise<T | 'pending'> => {
  let result: T | 'pending' = 'pending';
  void promise.then((value) => { result = value; });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return result;
};

describe('#7199 asking the person for a browser step: what the agent is told', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('taken over and handed back ⇒ done, with a fresh snapshot asked for', async () => {
    const b = browserWithTab('task-1');
    const told = b.requestTakeover('task-1', { reason: 'Enter the SMS code' });
    expect(person.pendingId(b)).toBeTruthy();
    expect(b.sessionInUse('task-1')).toBe(true);
    expect(b.acquireControl('viewer-1')).toBe('granted');
    b.releaseControl('viewer-1');
    await expect(told).resolves.toEqual({
      ok: true,
      message: 'The person did it and handed the browser back. Take a fresh browser_snapshot before you continue: the page may have changed.',
    });
    expect(person.pendingId(b)).toBeUndefined();
    expect(b.sessionInUse('task-1')).toBe(false);
  });

  it('declined ⇒ told to say what is needed and wait', async () => {
    const b = browserWithTab('task-1');
    const told = b.requestTakeover('task-1', {});
    person.decline(b, person.pendingId(b)!);
    await expect(told).resolves.toEqual({ ok: false, message: 'The person declined to take over. Tell them what is needed and wait.' });
  });

  it('nobody answers within ten minutes ⇒ timed out, not a moment earlier', async () => {
    const b = browserWithTab('task-1');
    const told = b.requestTakeover('task-1', {});
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1);
    expect(await settled(told)).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await expect(told).resolves.toEqual({
      ok: false,
      message: 'The person did not respond within 10 minutes. Tell them what you need in chat and stop for now.',
    });
    expect(person.pendingId(b)).toBeUndefined();
  });

  it('the person stops the task while it waits ⇒ stopped', async () => {
    const b = browserWithTab('task-1');
    const told = b.requestTakeover('task-1', {});
    b.stopAutomation();
    await expect(told).resolves.toEqual({ ok: false, message: STOPPED_MESSAGE });
  });

  it('the browser goes away while it waits ⇒ closed, with the reason', async () => {
    const b = browserWithTab('task-1');
    const told = b.requestTakeover('task-1', {});
    (b as unknown as { ended: (reason: string) => void }).ended('the task browser was released');
    await expect(told).resolves.toEqual({
      ok: false,
      message: 'The browser closed (the task browser was released). The next browser action opens it again.',
    });
  });

  it('another task asks meanwhile ⇒ the first is closed as declined, only the second waits', async () => {
    const b = browserWithTab('task-1', 'task-2');
    const first = b.requestTakeover('task-1', {});
    const second = b.requestTakeover('task-2', {});
    await expect(first).resolves.toEqual({ ok: false, message: 'The person declined to take over. Tell them what is needed and wait.' });
    expect(b.sessionInUse('task-2')).toBe(true);
    expect(b.sessionInUse('task-1')).toBe(false);
    person.decline(b, person.pendingId(b)!);
    await second;
  });

  it("the agent's call goes away ⇒ closed as declined", async () => {
    const b = browserWithTab('task-1');
    const call = new AbortController();
    const told = b.requestTakeover('task-1', {}, call.signal);
    call.abort();
    await expect(told).resolves.toEqual({ ok: false, message: 'The person declined to take over. Tell them what is needed and wait.' });
    expect(person.pendingId(b)).toBeUndefined();
  });
});
