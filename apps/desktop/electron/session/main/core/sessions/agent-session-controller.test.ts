import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_SESSION_ACTIONS } from '@gugu/session-core/session-record/contract';
import { agentSessionController, setAgentSessionHost } from './agent-session-controller';

describe('agentSession.<动作>:路由表上一个动作一个方法,怎么答交给宿主', () => {
  afterEach(() => setAgentSessionHost(null));

  it('方法就是那张表;每个方法把自己的名字、调用方、动作原样交给宿主', async () => {
    expect(Object.keys(agentSessionController).sort()).toEqual([...AGENT_SESSION_ACTIONS, 'spawnWithThinking'].sort());
    const host = vi.fn(async () => ({ ok: true }));
    setAgentSessionHost(host);
    await expect(agentSessionController.message({ deviceId: 'dev-b' }, { action: 'message' })).resolves.toEqual({ ok: true });
    expect(host).toHaveBeenCalledWith('message', { deviceId: 'dev-b' }, { action: 'message' });
  });

  it('宿主还没接上:带码的错误(经 taskhost.call 原样回到发起方),❌ 空结果', () => {
    expect(() => agentSessionController.get({}, { action: 'get' })).toThrow(expect.objectContaining({ code: 'host_not_ready' }));
  });

  it('the thinking capability forwards the same spawn and rejects malformed requests before the host', async () => {
    const host = vi.fn(async () => ({ session_id: 'child' }));
    setAgentSessionHost(host);
    const action = { action: 'spawn', prompt: 'hi', thinking: 'native-level' };
    await expect(agentSessionController.spawnWithThinking({ sessionId: 'parent' }, action)).resolves.toEqual({ session_id: 'child' });
    expect(host).toHaveBeenCalledWith('spawn', { sessionId: 'parent' }, action);
    for (const thinking of [undefined, '', ' ', 1]) {
      expect(() => agentSessionController.spawnWithThinking({}, { ...action, thinking })).toThrow(/non-empty reasoning level/);
    }
    expect(() => agentSessionController.spawnWithThinking({ kind: 'app' }, action)).toThrow(/agent spawn/);
    expect(host).toHaveBeenCalledOnce();
  });
});
