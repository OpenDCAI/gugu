import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', send: vi.fn(async (_input: unknown) => ({ status: 'queued' })) }));
vi.mock('@gugu/core/local/state/paths', () => ({ resolveGuguHome: () => fixture.root }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { reportHostWait: vi.fn() } }));
vi.mock('../sessions/agent-question-store', () => ({ readAgentQuestionRecords: () => [], rememberAgentQuestion: vi.fn(), settleAgentQuestionRecord: vi.fn() }));
vi.mock('../session-timeline/service', () => ({
  readSessionRow: (id: string) => id === 'missing' ? null : { projectId: 'project' }, syncAsked: vi.fn(), respond: vi.fn(),
}));
vi.mock('../sessions/sendMessage', () => ({ sendMessage: fixture.send }));

import { appHumanRequest, APP_HUMAN_TIMEOUT_MS } from '@shared/extensions/app-human';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { hostAsks, resetAsks } from '../asks/ask';
import { humanToolPending, runHumanTool, yieldHumanToolWaits } from '../asks/human-tool-wait';
import { sessionEvents } from '../sessions/session-events';
import { requestAppHuman } from './app-human-request';

const manifest = { id: 'notes', name: 'Notes', contributes: { tabs: [{ name: 'main', title: 'Notes' }] } } as ExtensionManifest;
const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function begin(sessionId = 'session') {
  const controller = new AbortController();
  const result = requestAppHuman(manifest, { sessionId, signal: controller.signal }, { title: 'Finish this step', tab: 'main' });
  const entry = [...hostAsks.get(sessionId)!.values()][0]!;
  return { controller, result, entry };
}

describe('an App program requests a human step on its calling session', () => {
  beforeEach(() => { fixture.root = mkdtempSync(join(tmpdir(), 'app-human-')); fixture.send.mockClear(); vi.useFakeTimers(); });
  afterEach(async () => { resetAsks(); await drain(); vi.useRealTimers(); rmSync(fixture.root, { recursive: true, force: true }); });

  it.each(['complete', 'cancel'])('returns the actual %s answer and its responder', async optionId => {
    const h = begin();
    expect(h.entry.request.origin).toMatchObject({ source: 'app-human', payload: { extensionId: 'notes', sessionId: 'session', tab: 'main' } });
    h.entry.answered({ optionId, by: 'phone' });
    await expect(h.result).resolves.toEqual({ requestId: h.entry.request.itemId, state: optionId === 'complete' ? 'completed' : 'cancelled', by: 'phone' });
    expect(hostAsks.size).toBe(0);
  });

  it('expires on the Ask deadline and does not imply completion', async () => {
    const h = begin();
    await vi.advanceTimersByTimeAsync(APP_HUMAN_TIMEOUT_MS);
    await expect(h.result).resolves.toMatchObject({ state: 'timeout' });
    expect(hostAsks.size).toBe(0);
  });

  it('ends on call cancellation', async () => {
    const h = begin(); h.controller.abort();
    await expect(h.result).resolves.toMatchObject({ state: 'ended' });
    expect(hostAsks.size).toBe(0);
  });

  it.each(['session:archived', 'session:deleted'] as const)('ends when its session is %s', async event => {
    const h = begin(); sessionEvents._emit(event, 'session'); await drain();
    await expect(h.result).resolves.toMatchObject({ state: 'ended' });
    expect(hostAsks.size).toBe(0);
  });

  it('cannot target another session/App or a tab this App does not declare', async () => {
    expect(() => appHumanRequest({ title: 'test', sessionId: 'other' })).toThrow('only title');
    expect(() => appHumanRequest({ title: 'test', extensionId: 'other' })).toThrow('only title');
    expect(() => appHumanRequest({ title: 'x'.repeat(501) })).toThrow('1–500');
    await expect(requestAppHuman(manifest, undefined, { title: 'test' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(requestAppHuman(manifest, { sessionId: 'missing', signal: new AbortController().signal }, { title: 'test' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(requestAppHuman(manifest, { sessionId: 'session', signal: new AbortController().signal }, { title: 'test', tab: 'elsewhere' })).rejects.toMatchObject({ code: 'invalid' });
    expect(hostAsks.size).toBe(0);
  });

  it('two simultaneous sessions keep separate questions and answers', async () => {
    const a = begin('a'); const b = begin('b');
    a.entry.answered({ optionId: 'complete', by: 'desktop' });
    await expect(a.result).resolves.toMatchObject({ state: 'completed' });
    expect(hostAsks.get('b')?.has(b.entry.request.itemId)).toBe(true);
    b.controller.abort(); await expect(b.result).resolves.toMatchObject({ state: 'ended' });
  });

  it('steering releases only the MCP waiter; the original answer is delivered once later', async () => {
    const controller = new AbortController();
    const tool = runHumanTool<unknown>('session', 'app_program', controller.signal,
      signal => requestAppHuman(manifest, { sessionId: 'session', signal }, { title: 'Finish this step' }), humanToolPending);
    const entry = [...hostAsks.get('session')!.values()][0]!;
    yieldHumanToolWaits('session');
    await expect(tool).resolves.toMatchObject({ state: 'pending', request_id: entry.request.itemId });
    controller.abort();
    expect(hostAsks.get('session')?.has(entry.request.itemId)).toBe(true);
    expect(fixture.send).not.toHaveBeenCalled();
    entry.answered({ optionId: 'complete', by: 'desktop' }); await drain();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session', text: expect.stringContaining('"state":"completed"') }));
  });
});
