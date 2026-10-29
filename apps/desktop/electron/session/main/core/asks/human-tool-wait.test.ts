import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', send: vi.fn(async (_input: unknown) => ({ status: 'queued' })) }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: {}, powerMonitor: { getSystemIdleTime: () => 999 } }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: vi.fn(async () => null) }));
vi.mock('../extensions/extension-bridge-relay', () => ({ requestExtensionInstallConsent: vi.fn(), closeExtensionInstallConsent: vi.fn() }));
vi.mock('@gugu/core/local/state/paths', () => ({ resolveGuguHome: () => fixture.root }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { reportHostWait: vi.fn(), on: vi.fn() } }));
vi.mock('../sessions/agent-question-store', () => ({ readAgentQuestionRecords: () => [], rememberAgentQuestion: vi.fn(), settleAgentQuestionRecord: vi.fn() }));
vi.mock('../session-timeline/service', () => ({ readSessionRow: () => ({ projectId: 'project' }), syncAsked: vi.fn() }));
vi.mock('../sessions/sendMessage', () => ({ sendMessage: fixture.send }));
vi.mock('../../../../mcp/gugu-im-server.mjs', () => ({
  extensionAttachmentOf: async () => ({ message_id: '0c000000-0000-4000-8000-0000000010a2' }),
}));

import { ask, hostAsks, resetAsks } from './ask';
import { humanToolPending, restoreHumanToolResults, runHumanTool, stopHumanToolWaits, yieldHumanToolWaits } from './human-tool-wait';
import { readHumanToolRecords, saveHumanToolRecord } from './human-tool-results';
import { CloudBrowser } from '../browser/cloud/cloud-browser';
import { askInstallInSession } from '../extensions/consent-in-session';
import { SessionCell } from '../../../../../../../packages/session-runtime/src/acp-agents/session/cell';
import { FakeAcpAgent } from '../../../../../../../packages/session-runtime/src/acp-agents/acp-test-support';
import { noopLogger } from '@gugu/session-shared/logger';
import { syncAsked } from '../session-timeline/service';
import { runAppAction } from '../../../../mcp/app-tool-host';

const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function waiting(sessionId = 'session', source: 'browser-assistance' | 'app-install' = 'browser-assistance') {
  const controller = new AbortController();
  const completed = vi.fn();
  const tool = runHumanTool<unknown>(sessionId, source === 'app-install' ? 'app_install' : 'browser_request_takeover', controller.signal, async signal => {
    const answer = await ask(sessionId, { itemId: `original-${sessionId}`, kind: 'permission', title: 'Original human request',
      options: [{ optionId: 'done', name: 'Done' }], origin: { source } }, { signal });
    completed(answer);
    return { outcome: typeof answer === 'string' ? answer : answer.optionId };
  }, humanToolPending);
  return { controller, tool, completed };
}
function answer(sessionId = 'session') {
  hostAsks.get(sessionId)!.get(`original-${sessionId}`)!.answered({ optionId: 'done', by: 'desktop' });
}

describe('a human request outlives only its steered tool waiter', () => {
  beforeEach(() => {
    fixture.root = mkdtempSync(join(tmpdir(), 'human-tool-wait-'));
    fixture.send.mockClear();
    vi.useFakeTimers();
  });
  afterEach(async () => { resetAsks(); await drain(); vi.useRealTimers(); rmSync(fixture.root, { recursive: true, force: true }); });

  it('yields promptly, keeps the exact request and survives the old MCP abort, then notifies once', async () => {
    const h = waiting();
    yieldHumanToolWaits('session');
    expect(await h.tool).toMatchObject({ state: 'pending', request_id: 'original-session' });
    const record = readHumanToolRecords('session')[0]!;
    expect(record.requestId).toBe('original-session');
    expect(hostAsks.get('session')?.has(record.requestId)).toBe(true);
    h.controller.abort();
    expect(hostAsks.get('session')?.has(record.requestId)).toBe(true);
    expect(h.completed).not.toHaveBeenCalled();
    answer();
    await drain();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session', clientMessageId: record.messageId,
      text: expect.stringContaining('"request_id":"original-session"') }));
    expect(readHumanToolRecords('session')).toEqual([]);
  });

  it('without steering waits for the actual answer and returns it synchronously without a second message', async () => {
    const h = waiting();
    const returned = vi.fn(); void h.tool.then(returned);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(returned).not.toHaveBeenCalled();
    answer();
    expect(await h.tool).toEqual({ outcome: 'done' });
    await drain();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(readHumanToolRecords('session')).toEqual([]);
  });

  it.each(['answer-first', 'steer-first'] as const)('settles concurrent answer/steer once: %s', async order => {
    const h = waiting();
    if (order === 'answer-first') { answer(); yieldHumanToolWaits('session'); }
    else { yieldHumanToolWaits('session'); answer(); }
    const result = await h.tool;
    await drain();
    expect(h.completed).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledTimes(order === 'steer-first' ? 1 : 0);
    expect(result).toMatchObject(order === 'steer-first' ? { state: 'pending' } : { outcome: 'done' });
  });

  it('does not yield a card answered immediately while its first snapshot is being published', async () => {
    vi.mocked(syncAsked).mockImplementationOnce(() => {
      hostAsks.get('session')!.get('original-session')!.answered({ optionId: 'done', by: 'desktop' });
      yieldHumanToolWaits('session');
    });
    const h = waiting();
    expect(await h.tool).toEqual({ outcome: 'done' });
    await drain();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(readHumanToolRecords('session')).toEqual([]);
  });

  it('multiple steers do not duplicate or reset the original ten-minute human deadline', async () => {
    const h = waiting();
    await vi.advanceTimersByTimeAsync(599_000);
    yieldHumanToolWaits('session');
    yieldHumanToolWaits('session');
    await h.tool;
    await vi.advanceTimersByTimeAsync(999);
    expect(h.completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await drain();
    expect(h.completed).toHaveBeenCalledWith('timeout');
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(hostAsks.has('session')).toBe(false);
  });

  it('isolates sessions and never interrupts an unregistered ordinary tool', async () => {
    const first = waiting('first'); const second = waiting('second');
    const returned = vi.fn(); void second.tool.then(returned);
    let complete!: (value: unknown) => void;
    const ordinary = runHumanTool<unknown>('first', 'app_install', undefined,
      () => new Promise(resolve => { complete = resolve; }), humanToolPending);
    const ordinaryReturned = vi.fn(); void ordinary.then(ordinaryReturned);
    yieldHumanToolWaits('first'); await first.tool; await drain();
    expect(returned).not.toHaveBeenCalled(); expect(ordinaryReturned).not.toHaveBeenCalled();
    complete({ actual: true }); expect(await ordinary).toEqual({ actual: true });
    answer('first'); answer('second'); await second.tool; await drain();
  });

  it('installation keeps waiting for consent; pending is not a confirmed install', async () => {
    const h = waiting('install', 'app-install');
    yieldHumanToolWaits('install');
    expect(await h.tool).toMatchObject({ state: 'pending', request_id: 'original-install' });
    expect(h.completed).not.toHaveBeenCalled();
    expect(hostAsks.get('install')!.has('original-install')).toBe(true);
    await vi.advanceTimersByTimeAsync(280_000);
    await drain();
    expect(h.completed).toHaveBeenCalledWith('timeout');
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });

  it('an explicit stop cancels the human request and leaves its result for the next real resume', async () => {
    const h = waiting(); yieldHumanToolWaits('session'); await h.tool;
    stopHumanToolWaits('session'); await drain();
    expect(hostAsks.has('session')).toBe(false);
    expect(h.completed).toHaveBeenCalledWith('withdrawn');
    expect(fixture.send).not.toHaveBeenCalled();
    restoreHumanToolResults('session', 'project'); await drain();
    expect(fixture.send).not.toHaveBeenCalled();
    restoreHumanToolResults('session', 'project', true); await drain();
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });

  it('reconciles a host restart as ended, never as approval; retries use the same durable result ID', async () => {
    const record = { id: 'operation', sessionId: 'session', requestId: 'same-human-card', tool: 'browser_request_login' as const,
      messageId: 'a50457a7-8e2f-4f27-b0cc-dd3de59a0c1e', state: 'waiting' as const };
    saveHumanToolRecord(record);
    restoreHumanToolResults('session', 'project');
    restoreHumanToolResults('session', 'project');
    await drain();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ clientMessageId: record.messageId,
      text: expect.stringContaining('"state":"ended"') }));
    expect(readHumanToolRecords('session')).toEqual([]);
  });

  it('remembers a steer during this operation until its human request is registered', async () => {
    let begin!: () => void;
    const setup = new Promise<void>(resolve => { begin = resolve; });
    const tool = runHumanTool<unknown>('session', 'browser_request_takeover', undefined, async signal => {
      await setup;
      return ask('session', { itemId: 'late-card', kind: 'permission', title: 'Take over', options: [],
        origin: { source: 'browser-assistance' } }, { signal });
    }, humanToolPending);
    const returned = vi.fn(); void tool.then(returned);
    yieldHumanToolWaits('session'); begin();
    await drain();
    expect(returned).toHaveBeenCalledWith(expect.objectContaining({ state: 'pending', request_id: 'late-card' }));
    hostAsks.get('session')!.get('late-card')!.answered({ optionId: 'done', by: 'desktop' });
    expect(await tool).toMatchObject({ state: 'pending', request_id: 'late-card' });
    await drain();
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });

  it('retries a failed result handoff with the same message ID and the recorded actual result', async () => {
    fixture.send.mockRejectedValueOnce(new Error('temporary handoff failure'));
    const h = waiting(); yieldHumanToolWaits('session'); await h.tool;
    const id = readHumanToolRecords('session')[0]!.messageId;
    answer(); await drain();
    expect(readHumanToolRecords('session')[0]).toMatchObject({ messageId: id, state: 'finished', result: { outcome: 'done' } });
    restoreHumanToolResults('session', 'project'); await drain();
    expect(fixture.send).toHaveBeenCalledTimes(2);
    expect(fixture.send.mock.calls.map(([input]) => (input as { clientMessageId: string }).clientMessageId)).toEqual([id, id]);
    expect(readHumanToolRecords('session')).toEqual([]);
  });

  it('the real CloudBrowser takeover keeps its card and sends its actual hand-back result', async () => {
    const browser = new CloudBrowser({ PATH: '' }, fixture.root);
    (browser as unknown as { sessionTab: Map<string, string> }).sessionTab.set('session', 'tab');
    const call = new AbortController();
    const tool = browser.requestTakeover('session', { reason: 'Finish this step' }, call.signal);
    const requestId = [...hostAsks.get('session')!.keys()][0]!;
    yieldHumanToolWaits('session');
    expect(JSON.parse((await tool).message)).toMatchObject({ state: 'pending', request_id: requestId });
    call.abort();
    expect(hostAsks.get('session')!.has(requestId)).toBe(true);
    hostAsks.get('session')!.get(requestId)!.answered({ optionId: 'done', by: 'desktop' });
    await drain();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    const message = (fixture.send.mock.calls[0]![0] as { text: string }).text;
    expect(message).toContain('handed the browser back');
    expect(message).toContain('fresh browser_snapshot');
  });

  it('the actual session admission releases a real browser wait before the adapter consumes the owner message', async () => {
    const browser = new CloudBrowser({ PATH: '' }, fixture.root);
    (browser as unknown as { sessionTab: Map<string, string> }).sessionTab.set('session', 'tab');
    const tool = browser.requestTakeover('session', { reason: 'The person must finish this' });
    const requestId = [...hostAsks.get('session')!.keys()][0]!;
    const consumed: string[] = []; const admitted: string[] = [];
    const agent = new FakeAcpAgent();
    agent.extMethod = vi.fn(async (_method, params) => {
      admitted.push((params as { prompt: { text: string }[] }).prompt[0]!.text);
      return { outcome: 'injected' };
    });
    agent.prompt = vi.fn(async () => { await tool; consumed.push(...admitted); return { stopReason: 'end_turn' as const }; });
    const cell = new SessionCell({ sessionId: 'session', projectId: 'project', providerId: 'claude', acpSessionId: 'native',
      agent, supportsSteering: true, resolveAttachment: vi.fn(), logger: noopLogger,
      callbacks: { onPromptSteered: () => yieldHumanToolWaits('session') } });
    cell.applySessionReady();
    const turn = cell.prompt({ text: 'delegated task', origin: 'typed' }); await drain();
    await cell.queueBehindTurn({ text: 'owner input must enter now', origin: 'manual' });
    await drain();
    expect(consumed).toEqual(['owner input must enter now']);
    expect(hostAsks.get('session')!.has(requestId)).toBe(true);
    expect(fixture.send).not.toHaveBeenCalled();
    hostAsks.get('session')!.get(requestId)!.answered({ optionId: 'done', by: 'desktop' });
    await turn; await drain();
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });

  it('the real installation sheet remains open until fingerprinted consent and reports final install completion', async () => {
    const closed = vi.fn(async () => undefined);
    let installed = false;
    let finishInstall!: () => void;
    const actualInstall = new Promise<void>(resolve => { finishInstall = resolve; });
    const tool = runHumanTool<unknown>('session', 'app_install', undefined, async signal => {
      const consent = await askInstallInSession('session', { sourceDir: '/tmp/app', manifest: { id: 'sample', name: 'Sample' },
        manifestDigest: 'exact-manifest', revokedPermissions: [], given: { first: true } } as never,
      { name: 'Agent', agentUserId: null }, { timeline: async () => ({ ask, respond: vi.fn() }),
        idleSeconds: () => 999, window: null, closeWindow: closed } as never, signal);
      if (consent.outcome !== 'confirmed') return { installed: false, ...consent };
      await actualInstall; installed = true; return { installed: true, id: 'sample' };
    }, humanToolPending);
    await drain();
    const entry = [...hostAsks.get('session')!.values()][0]!;
    yieldHumanToolWaits('session');
    expect(await tool).toMatchObject({ state: 'pending', request_id: entry.request.itemId });
    expect(installed).toBe(false); expect(closed).not.toHaveBeenCalled();
    expect(entry.refuse!({ optionId: 'install', by: 'phone' })).toContain('did not show it');
    expect(entry.refuse!({ optionId: 'install', by: 'phone', digest: 'exact-manifest' })).toBeNull();
    entry.answered({ optionId: 'install', by: 'phone', digest: 'exact-manifest' }); await drain();
    expect(installed).toBe(false); expect(fixture.send).not.toHaveBeenCalled();
    finishInstall(); await drain();
    expect(installed).toBe(true); expect(closed).toHaveBeenCalledWith(entry.request.itemId);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect((fixture.send.mock.calls[0]![0] as { text: string }).text).toContain('"installed":true');
  });

  it('a cross-device install yields the whole workflow, then installs the approved bytes before reporting completion', async () => {
    let finishInstall!: () => void;
    const installed = new Promise<void>(resolve => { finishInstall = resolve; });
    const finalInstall = vi.fn(async () => { await installed; return { installed: true, outcome: 'confirmed' }; });
    const caller = new AbortController();
    const tool = runAppAction({ action: 'install', device: 'other',
      source_message_id: 'msg:0c000000-0000-4000-8000-0000000010a2' },
    { kind: 'social', grantKey: 'taskpage:session' } as never,
    async (action, signal) => runHumanTool<unknown>('session', 'app_install', signal ?? caller.signal, async lifetime => {
      expect((action as { action: string }).action).toBe('ask_install');
      return askInstallInSession('session', { sourceDir: '/tmp/app', manifest: { id: 'sample', name: 'Sample' },
        manifestDigest: 'same-bytes', revokedPermissions: [], given: { first: true } } as never,
      { name: 'Agent', agentUserId: null }, { timeline: async () => ({ ask, respond: vi.fn() }),
        idleSeconds: () => 999, window: null, closeWindow: vi.fn(async () => undefined) } as never, lifetime);
    }, humanToolPending),
    async action => {
      const request = action as { action: string; consent?: { kind: string; digest?: string } };
      if (request.action === 'devices') return [{ device_id: 'other', label: 'Other computer' }];
      if (request.consent?.kind === 'return') return { outcome: 'ask', asks: true, ask: { manifestDigest: 'same-bytes' } };
      expect(request.consent).toEqual({ kind: 'given', digest: 'same-bytes' });
      return finalInstall();
    }, caller.signal);
    await vi.waitFor(() => expect(hostAsks.get('session')?.size).toBe(1));
    const entry = [...hostAsks.get('session')!.values()][0]!;
    yieldHumanToolWaits('session');
    expect(await tool).toMatchObject({ state: 'pending', request_id: entry.request.itemId });
    caller.abort();
    entry.answered({ optionId: 'install', by: 'desktop', digest: 'same-bytes' });
    await drain();
    expect(finalInstall).toHaveBeenCalledTimes(1);
    expect(fixture.send).not.toHaveBeenCalled();
    finishInstall(); await drain();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect((fixture.send.mock.calls[0]![0] as { text: string }).text).toContain('"installed":true');
  });
});
