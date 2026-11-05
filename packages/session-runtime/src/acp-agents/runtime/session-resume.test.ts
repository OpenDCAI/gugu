/**
 * ACP `session/resume`:适配器只声明 `sessionCapabilities.resume`(不声明 `loadSession`)时,接回原 provider
 * session 走它 —— 不重放历史,回合序号从宿主给的库尾接着数,补投按「可能已收到」处理(没有重放可供去重)。
 * 两样都声明走 load(重放是更强的那一个);两样都没有退回 `session/new`(旧行为)。
 */
import { describe, expect, it, vi } from 'vitest';
import { isOk } from '@gugu/session-shared';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';
import { recoverDeliveryEnvelopes } from '../../../../core/src/local/agent/deliveryEnvelope';

const resumeOnly = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } };
const DELIVERY = '<gugu_delivery route="chat" from="B" from_id="user:b" chat="test" msg="msg:queued-1"><![CDATA[ping]]></gugu_delivery>';
const promptText = (request: { prompt: Array<{ type: string; text?: string }> }) =>
  request.prompt.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');

describe('reattaching through ACP session/resume', () => {
  it('a resume-only adapter is reattached with session/resume: same provider session, no load, no new session', async () => {
    const h = makeAcpHarness();
    h.agent.initialize.mockResolvedValue(resumeOnly);
    const rt = new AcpRuntime(h.deps);

    const result = await rt.resumeSession({ ...makeStartInput({ sessionId: 'conv-resume' }), providerSessionId: 'dsh-1' });

    expect(result).toMatchObject({ success: true, data: { providerSessionId: 'dsh-1' } });
    expect(h.agent.resumeSession).toHaveBeenCalledTimes(1);
    expect(h.agent.resumeSession.mock.calls[0][0]).toMatchObject({ sessionId: 'dsh-1', cwd: expect.any(String) });
    expect(h.agent.loadSession).not.toHaveBeenCalled();
    expect(h.agent.newSession).not.toHaveBeenCalled();
    expect(rt.getSessionState('conv-resume').lifecycle).toBe('ready');
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-resume']?.canReattach).toBe(true);
  });

  it('new turns continue after the stored ones (nothing is replayed to push the index up)', async () => {
    const h = makeAcpHarness();
    h.agent.initialize.mockResolvedValue(resumeOnly);
    const rt = new AcpRuntime(h.deps);
    expect(isOk(await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-resume-index', turnIndexBase: 5 }), providerSessionId: 'dsh-1',
    }))).toBe(true);

    expect(isOk(await rt.sendPrompt('conv-resume-index', { text: 'hello again', origin: 'manual' }))).toBe(true);
    await vi.waitFor(() => {
      const history = rt.getChatHistory('conv-resume-index');
      expect((history.committed[0] ?? history.active)?.id).toBe('conv-resume-index:turn:5');
    });
  });

  it('a queued delivery is redelivered marked possibly received: there is no replay to deduplicate against', async () => {
    const h = makeAcpHarness({ recoverDelivery: recoverDeliveryEnvelopes });
    h.agent.initialize.mockResolvedValue(resumeOnly);
    const rt = new AcpRuntime(h.deps);
    expect(isOk(await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-resume-queue', initialQueue: [{ text: DELIVERY, origin: 'communication' }] }),
      providerSessionId: 'dsh-1',
    }))).toBe(true);

    await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalledTimes(1));
    expect(promptText(h.agent.prompt.mock.calls[0][0])).toContain('possibly_received="true"');
  });

  it('an adapter that declares both reattaches with session/load (replay wins)', async () => {
    const h = makeAcpHarness();
    h.agent.initialize.mockResolvedValue({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    const rt = new AcpRuntime(h.deps);

    expect(isOk(await rt.resumeSession({ ...makeStartInput({ sessionId: 'conv-both' }), providerSessionId: 'p-1' }))).toBe(true);
    expect(h.agent.loadSession).toHaveBeenCalledTimes(1);
    expect(h.agent.resumeSession).not.toHaveBeenCalled();
  });

  it('an adapter that declares neither cannot be reattached: session/new, and the summary says so', async () => {
    const h = makeAcpHarness();
    h.agent.initialize.mockResolvedValue({ protocolVersion: 1, agentCapabilities: {} });
    h.agent.newSession.mockResolvedValue({ sessionId: 'fresh' });
    const rt = new AcpRuntime(h.deps);

    expect(isOk(await rt.resumeSession({ ...makeStartInput({ sessionId: 'conv-neither' }), providerSessionId: 'p-1' }))).toBe(true);
    expect(h.agent.loadSession).not.toHaveBeenCalled();
    expect(h.agent.resumeSession).not.toHaveBeenCalled();
    expect(h.agent.newSession).toHaveBeenCalledTimes(1);
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-neither']?.canReattach).toBe(false);
  });

  it('a missing provider session is reported as missing, not silently replaced by a new one', async () => {
    const h = makeAcpHarness();
    h.agent.initialize.mockResolvedValue(resumeOnly);
    h.agent.resumeSession.mockRejectedValue({ code: -32002, message: 'Session not found: dsh-gone' });
    const rt = new AcpRuntime(h.deps);

    const result = await rt.resumeSession({ ...makeStartInput({ sessionId: 'conv-gone' }), providerSessionId: 'dsh-gone' });

    expect(result).toMatchObject({ success: false, error: { type: 'provider_session_missing' } });
    expect(h.agent.newSession).not.toHaveBeenCalled();
  });
});
