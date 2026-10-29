import { decodeSessionUpdate } from '@gugu/session-core/acp';
/**
 * `lastActionAt` on the runtime summary is the newest tool action, kept past the five-minute window that
 * `recentActions` uses — the same contract as the session record's timeline (contract.ts). Before, the window
 * trimmed the newest entry too, so an open session quiet for five minutes read `null`: a stuck agent looked idle.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { isOk } from '@gugu/session-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../tests/support/awaitCondition';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const SESSION = 'session-1';

afterEach(() => vi.restoreAllMocks());

describe('runtime summary lastActionAt', () => {
  it('keeps the newest tool action after the recent-actions window has emptied', async () => {
    let now = Date.UTC(2026, 9, 8, 14, 0);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    expect(isOk(await rt.startSession(makeStartInput({ sessionId: 'conv-last-action' })))).toBe(true);
    const client = h.client();
    h.agent.prompt = vi.fn().mockImplementationOnce(() => new Promise(() => {}));
    void rt.sendPrompt('conv-last-action', { text: 'run sleep 600' });
    await h.agent.called('prompt');
    const summary = () => rt.sessionsListLiveModel().states.list.snapshot().data['conv-last-action'];

    const toolAt = now;
    await client.sessionEvent({
      sessionId: SESSION,
      event: decodeSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'call_sleep', title: 'sleep 600', kind: 'execute', status: 'in_progress' } as SessionUpdate),
    });
    await until('the tool action is in the summary', () => summary()?.lastActionAt, (at) => at === toolAt);
    expect(summary()?.recentActions?.length).toBe(1);

    now += 6 * 60_000;
    await client.sessionEvent({
      sessionId: SESSION,
      event: decodeSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still waiting' } } as SessionUpdate),
    });
    await until('the window has emptied', () => summary()?.recentActions?.length, (n) => n === 0);
    expect(summary()?.lastActionAt, 'the fact stays: its last tool action was six minutes ago').toBe(toolAt);
  });
});
