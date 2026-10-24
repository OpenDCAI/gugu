import { describe, expect, it, vi } from 'vitest';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import type { NormalizedEvent, SessionPromptReceipt } from '@gugu/session-core/acp';
import { noopLogger } from '@gugu/session-shared/logger';
import { SessionCell } from './cell';

function nativeCell() {
  const receipts: ReturnType<typeof Promise.withResolvers<SessionPromptReceipt>>[] = [];
  const prompt = vi.fn((_request, _dispatch) => {
    const receipt = Promise.withResolvers<SessionPromptReceipt>();
    receipts.push(receipt);
    return receipt.promise;
  });
  const cell = new SessionCell({ sessionId: 'c', projectId: 'p', providerId: 'fixture', acpSessionId: 's',
    agent: { prompt, cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
    resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger });
  cell.applySessionReady();
  const state = (state: 'running' | 'idle', extra: object = {}) => cell.push({ kind: 'agent_state', source: 'agent', state, ...extra } as NormalizedEvent);
  const echo = (id = 'native', text = 'body') => cell.push({ kind: 'message', role: 'user', messageId: id, text, contentMode: 'replace' });
  return { cell, prompt, receipts, state, echo };
}

describe('one foreground cycle authority', () => {
  it.each(['rwei', 'wrei', 'weri', 'weir', 'ewri', 'ewir'])('receipt/echo/state order %s', async order => {
    const p = nativeCell();
    const sent = p.cell.promptDetached({ text: 'body' });
    await sent.admission;
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
    const requestId = p.prompt.mock.calls[0][1].requestId;
    for (const action of order) {
      if (action === 'r') {
        p.receipts[0].resolve({ status: 'accepted', requestId, messageId: 'native' });
        await p.receipts[0].promise;
      }
      if (action === 'w') p.state('running');
      if (action === 'e') p.echo();
      if (action === 'i') {
        p.state('idle', { stopReason: 'max_tokens', usage: { totalTokens: 7 } });
        // Idle closes the foreground; caller completion also needs its native identity.
        expect(p.cell.sessionState.lifecycle).toBe('ready');
      }
    }
    expect(await sent.completion).toMatchObject({ success: true });
    const history = p.cell.history();
    expect(history.active).toBeNull();
    expect(history.committed).toHaveLength(1);
    expect(history.committed[0].items.filter(item => item.kind === 'message')).toHaveLength(1);
    expect(history.committed[0]).toMatchObject({ outcome: { kind: 'done', reason: 'max_tokens' },
      foreground: { source: 'agent', state: 'idle', stopReason: 'max_tokens', usage: { totalTokens: 7 } } });
  });

  it('a late receipt cannot finish the next cycle drained by idle', async () => {
    const p = nativeCell();
    const first = p.cell.promptDetached({ text: 'first' });
    await first.admission;
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
    p.state('running'); p.echo('u1', 'first');
    await p.cell.queueBehindTurn({ text: 'second', origin: 'manual' });
    p.state('idle', { stopReason: 'end_turn' });
    expect(p.prompt).toHaveBeenCalledTimes(1);
    p.receipts[0].resolve({ status: 'accepted', requestId: p.prompt.mock.calls[0][1].requestId, messageId: 'u1' });
    await first.completion;
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(2));
    p.state('running'); p.echo('u2', 'second');
    expect(p.cell.sessionState.lifecycle).toBe('working');
    expect(p.cell.history().committed).toHaveLength(1);
    p.state('idle', { stopReason: 'end_turn' });
    p.receipts[1].resolve({ status: 'accepted', requestId: p.prompt.mock.calls[1][1].requestId, messageId: 'u2' });
    await p.receipts[1].promise;
    expect(p.cell.history().committed).toHaveLength(2);
  });

  it.each(['idle', 'exit', 'close'])('settles an accepted request with no echo at %s', async boundary => {
    const p = nativeCell();
    const sent = p.cell.promptDetached({ text: 'not inserted' });
    await sent.admission;
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
    p.receipts[0].resolve({ status: 'accepted', requestId: p.prompt.mock.calls[0][1].requestId, messageId: 'missing' });
    await p.receipts[0].promise;
    if (boundary === 'idle') p.state('idle', { stopReason: 'end_turn' });
    if (boundary === 'exit') p.cell.processClosed({ exitCode: 1, signal: null, stderrTail: '' });
    if (boundary === 'close') p.cell.dispose();
    expect(await sent.completion).toMatchObject({ success: false });
  });

  it('two inserted messages can share a cycle without the second receipt completing the first', async () => {
    const p = nativeCell();
    const first = p.cell.promptDetached({ text: 'first' });
    await first.admission;
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
    p.state('running'); p.echo('u1', 'first');
    const second = p.cell.promptDetached({ text: 'second' }, { steerIfBusy: true });
    await second.admission;
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(2));
    p.echo('u2', 'second');
    p.receipts[1].resolve({ status: 'accepted', requestId: p.prompt.mock.calls[1][1].requestId, messageId: 'u2' });
    await second.completion;
    let completed = false;
    void first.completion.then(() => { completed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    p.receipts[0].resolve({ status: 'accepted', requestId: p.prompt.mock.calls[0][1].requestId, messageId: 'u1' });
    await p.receipts[0].promise;
    p.state('idle', { stopReason: 'end_turn' });
    expect(await first.completion).toMatchObject({ success: true });
    expect(p.cell.history().committed).toHaveLength(1);
    expect(p.cell.history().committed[0].items.filter(item => item.kind === 'message' && item.role === 'user')).toHaveLength(2);
  });

  it('unsolicited cycles need no prompt and replayed state cannot revive them', () => {
    const p = nativeCell();
    p.state('running');
    p.cell.push({ kind: 'message', role: 'assistant', messageId: 'autonomous', text: 'notice result' });
    p.state('idle', { stopReason: null });
    expect(p.cell.history().committed[0]).toMatchObject({ initiator: 'agent',
      outcome: { kind: 'done', reason: 'cycle_end' }, foreground: { stopReason: null } });
    p.cell.beginReplay();
    p.state('running');
    p.cell.endReplay();
    expect(p.cell.sessionState.lifecycle).toBe('ready');
    expect(p.prompt).not.toHaveBeenCalled();
  });

  it('parent idle accepts another input while its independent child is still running', async () => {
    const p = nativeCell();
    p.state('running'); p.echo('first');
    p.cell.push({ kind: 'subagent', toolCallId: 'delegate', title: 'Child', status: 'in_progress',
      parentToolCallId: null, background: true, subagentSessionId: 'child' });
    p.state('idle', { stopReason: 'end_turn' });
    expect(p.cell.sessionState.lifecycle).toBe('ready');
    expect(p.cell.sessionState.backgroundAgentCount).toBe(1);
    const next = p.cell.promptDetached({ text: 'continue', origin: 'manual' });
    expect(await next.admission).toMatchObject({ success: true, data: { queued: false } });
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
    p.state('running'); p.echo('second', 'continue');
    p.state('idle', { stopReason: 'end_turn' });
    p.receipts[0].resolve({ status: 'accepted', requestId: p.prompt.mock.calls[0][1].requestId, messageId: 'second' });
    await next.completion;
    expect(p.cell.sessionState.backgroundAgentCount).toBe(1);
  });

  it('unknown reasons and full native errors survive independently of receipts', async () => {
    const p = nativeCell();
    p.state('running'); p.echo();
    p.state('idle', { stopReason: '_future', _meta: { native: 1 }, usage: null });
    expect(p.cell.history().committed[0].foreground).toMatchObject({ stopReason: '_future', usage: null, _meta: { native: 1 } });
    p.state('running'); p.echo('failed');
    p.state('idle', { stopReason: 'error', error: { code: -32000, message: 'auth needed', data: { native: true } } });
    expect(p.cell.history().committed[1]).toMatchObject({ outcome: { kind: 'error' },
      foreground: { error: { code: -32000, message: 'auth needed', data: { native: true } } } });
  });

  it('connection exit finishes an active cycle and a late receipt cannot resurrect it', async () => {
    const p = nativeCell();
    const sent = p.cell.promptDetached({ text: 'body' });
    await sent.admission;
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
    p.state('running'); p.echo();
    p.cell.processClosed({ exitCode: null, signal: 'SIGKILL', stderrTail: '' });
    expect(await sent.completion).toMatchObject({ success: false });
    p.receipts[0].resolve({ status: 'accepted', requestId: p.prompt.mock.calls[0][1].requestId, messageId: 'native' });
    await p.receipts[0].promise;
    expect(p.cell.history().active).toBeNull();
    expect(p.cell.history().committed).toHaveLength(1);
    expect(p.cell.history().committed[0].outcome).toMatchObject({ kind: 'error', reason: 'process_closed' });
  });

  it('a refused dispatch ends its reservation without inventing an agent idle', async () => {
    const p = nativeCell();
    const sent = p.cell.promptDetached({ text: 'refused', origin: 'manual' });
    await sent.admission;
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
    p.receipts[0].reject(Object.assign(new Error('input refused'), { code: -32602 }));
    expect(await sent.completion).toMatchObject({ success: false });
    expect(p.cell.history().committed[0].outcome).toMatchObject({ kind: 'error' });
    expect(p.cell.history().committed[0].foreground).toBeUndefined();
  });

  it('cancel after dispatch and before running retains the native cancellation outcome', async () => {
    const p = nativeCell();
    const sent = p.cell.promptDetached({ text: 'cancel before insertion' });
    await sent.admission;
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
    await p.cell.cancel();
    p.receipts[0].reject(Object.assign(new Error('Request cancelled'), { code: -32800 }));
    await sent.completion;
    expect(p.cell.history().committed[0].outcome).toEqual({ kind: 'cancelled', reason: 'cancelled' });
    expect(p.cell.history().committed[0].foreground).toBeUndefined();
    expect(p.cell.sessionState.lifecycle).toBe('ready');
  });

  it('a late refusal cannot close running native work; idle still owns the cycle boundary', async () => {
    const p = nativeCell();
    const sent = p.cell.promptDetached({ text: 'body', origin: 'manual' });
    await sent.admission;
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
    p.state('running');
    const rejected = p.receipts[0].promise.catch(() => {});
    p.receipts[0].reject(new Error('request refused'));
    await rejected;
    expect(p.cell.sessionState.lifecycle).toBe('working');
    expect(p.cell.history().committed).toEqual([]);
    p.state('idle', { stopReason: 'end_turn', _meta: { guguRevert: { before: 'native-cycle' } } });
    await sent.completion;
    expect(p.cell.history().committed[0].items[0]).toMatchObject({ revertAnchor: 'native-cycle' });
  });
});
