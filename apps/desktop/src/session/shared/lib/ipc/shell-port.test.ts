import { describe, expect, it, vi } from 'vitest';
import {
  answerSessionShellChannels,
  createSessionShellPort,
  isSessionShellChannel,
  isSessionShellUnsupported,
  SESSION_SHELL_CHANNELS,
  SessionShellUnsupportedError,
} from './shell-port';

describe('createSessionShellPort', () => {
  it('maps every port method onto its channel with the caller arguments', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === SESSION_SHELL_CHANNELS.agentCard) return { agentUserId: 'u1', displayName: 'Codex 8' };
      if (channel === SESSION_SHELL_CHANNELS.agentNames)
        return [
          { conversationId: 'conv-1', displayName: 'Codex 8', agentUserId: 'u1' },
          // #6092 少 agent id 的行不占一格:半条身份画不出一张完整的卡。
          { conversationId: 'conv-2', displayName: 'ghost' },
        ];
      if (channel === SESSION_SHELL_CHANNELS.renameAgent)
        return { conversationId: 'conv-1', displayName: 'Codex 9', agentUserId: 'u1' };
      if (channel === SESSION_SHELL_CHANNELS.shareAgent) return true;
      if (channel === SESSION_SHELL_CHANNELS.ensureAgentAddress) return { chatId: 'c1', agentUserId: 'u1' };
      return undefined;
    });
    const port = createSessionShellPort(invoke);

    await expect(port.agentCard('conv-1')).resolves.toEqual({ agentUserId: 'u1', displayName: 'Codex 8' });
    await expect(port.agentNames()).resolves.toEqual([
      { conversationId: 'conv-1', displayName: 'Codex 8', agentUserId: 'u1' },
    ]);
    await expect(port.renameAgent({ sessionId: 'conv-1', name: 'Codex 9' })).resolves.toEqual({
      conversationId: 'conv-1',
      displayName: 'Codex 9',
      agentUserId: 'u1',
    });
    await expect(port.shareAgent('conv-1')).resolves.toBe(true);
    await expect(
      port.ensureAgentAddress({ projectId: 'p', sessionId: 'conv-1' }),
    ).resolves.toEqual({ chatId: 'c1', agentUserId: 'u1' });
    await expect(port.fatalBoot('boom')).resolves.toBeUndefined();

    expect(invoke.mock.calls).toEqual([
      [SESSION_SHELL_CHANNELS.agentCard, 'conv-1'],
      [SESSION_SHELL_CHANNELS.agentNames],
      [SESSION_SHELL_CHANNELS.renameAgent, { sessionId: 'conv-1', name: 'Codex 9' }],
      [SESSION_SHELL_CHANNELS.shareAgent, 'conv-1'],
      [SESSION_SHELL_CHANNELS.ensureAgentAddress, { projectId: 'p', sessionId: 'conv-1' }],
      [SESSION_SHELL_CHANNELS.fatalBoot, 'boom'],
    ]);
  });

  it('treats a card without agentUserId as "no identity" and a half address as a failure', async () => {
    const port = createSessionShellPort(async (channel) =>
      channel === SESSION_SHELL_CHANNELS.agentCard ? { displayName: 'ghost' } : { chatId: 'c1' },
    );
    await expect(port.agentCard('conv')).resolves.toBeNull();
    // 改名回执残缺 = 没改成,❌ 把它当成功往侧栏上写。
    await expect(port.renameAgent({ sessionId: 'conv', name: 'x' })).rejects.toThrow(/renamed agent/);
    await expect(
      port.ensureAgentAddress({ projectId: 'p', sessionId: 'conv' }),
    ).rejects.toThrow(/exact agent address/);
  });
});

describe('answerSessionShellChannels', () => {
  it('answers shell channels in place and never forwards them to the host', async () => {
    const host = vi.fn(async () => 'from-host');
    const invoke = answerSessionShellChannels(host, {
      agentCard: async (sessionId) => ({ agentUserId: `agent-of-${sessionId}`, displayName: 'A' }),
    });

    await expect(invoke(SESSION_SHELL_CHANNELS.agentCard, 'conv')).resolves.toEqual({
      agentUserId: 'agent-of-conv',
      displayName: 'A',
    });
    await expect(invoke('workspace.gitWorktree.clone', 'x')).resolves.toBe('from-host');
    expect(host.mock.calls).toEqual([['workspace.gitWorktree.clone', 'x']]);
  });

  it('turns a missing answer into a typed unsupported error instead of a host round trip', async () => {
    const host = vi.fn(async () => undefined);
    const invoke = answerSessionShellChannels(host, {});
    const error = await invoke(SESSION_SHELL_CHANNELS.shareAgent, 'conv').catch((e: unknown) => e);
    expect(isSessionShellUnsupported(error)).toBe(true);
    expect((error as SessionShellUnsupportedError).channel).toBe(SESSION_SHELL_CHANNELS.shareAgent);
    expect(host).not.toHaveBeenCalled();
    // 阴性对照:普通错误不算「不支持」。
    expect(isSessionShellUnsupported(new Error('task shell does not answer'))).toBe(false);
  });

  it('recognises exactly the declared channels', () => {
    for (const channel of Object.values(SESSION_SHELL_CHANNELS)) expect(isSessionShellChannel(channel)).toBe(true);
    expect(isSessionShellChannel('sessionpage:agent-context')).toBe(false);
    expect(isSessionShellChannel('vcs.commit')).toBe(false);
  });
});
