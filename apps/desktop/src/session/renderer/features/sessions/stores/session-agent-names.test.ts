// #6264 一套工作台:别的机器上的会话,身份卡也要有 Agent 名与 Agent ID。
// owner 实测:悬停 d22 上的会话,卡上写「Agent 名 未分配 / Agent ID 未分配」—— 表只在启动那一刻读一次,
// 那时 d22 的会话还没到。现在别的机器上的那一半读会话目录(行上带 agent id,名字从身份缓存取):
// 目录到了 / 变了、身份缓存补到了名字,都再收一遍;❌ 逐台机器去问(#7016:掉线又回来的那台会卡到超时)。
import { describe, expect, it, vi } from 'vitest';
import type { SessionShellAgentName } from '@shared/lib/ipc/shell-port';
import { SessionAgentNames, type SessionAgentNamesSource } from './session-agent-names';

const LOCAL: SessionShellAgentName = { conversationId: 'conv-local-1', displayName: 'Claude 3', agentUserId: 'agent-local-uuid' };
const REMOTE: SessionShellAgentName = { conversationId: 'conv-d22-1', displayName: 'Codex 8', agentUserId: 'agent-d22-uuid' };

function fakeSource(options: { all?: SessionShellAgentName[]; remote?: SessionShellAgentName[] } = {}) {
  let identityListener: ((event: SessionShellAgentName) => void) | null = null;
  let remoteListener: (() => void) | null = null;
  let directoryListener: (() => void) | null = null;
  let remote = options.remote ?? [];
  const source: SessionAgentNamesSource = {
    readAll: () => Promise.resolve(options.all ?? []),
    readRemote: () => remote,
    onRemoteChange: (cb) => {
      remoteListener = cb;
      return () => (remoteListener = null);
    },
    onIdentityEvent: (cb) => {
      identityListener = cb;
      return () => (identityListener = null);
    },
    directory: () => ({
      getSnapshot: () => null,
      subscribe: (cb) => {
        directoryListener = cb;
        return () => (directoryListener = null);
      },
      ensure: () => undefined,
    }),
  };
  return {
    source,
    push: (event: SessionShellAgentName) => identityListener?.(event),
    /** 会话目录变了(那台机器的列表到了)。 */
    directoryChanged: (rows: SessionShellAgentName[]) => {
      remote = rows;
      remoteListener?.();
    },
    /** 身份缓存补到了名字(目录行早就在,名字这时才有)。 */
    identitiesArrived: (rows: SessionShellAgentName[]) => {
      remote = rows;
      directoryListener?.();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('sessionAgentNames 覆盖别的机器上的会话 (#6264)', () => {
  it('那台机器的会话列表到了 ⇒ 从会话目录收进来,远端会话的身份卡有名字与 ID', async () => {
    const fake = fakeSource({ all: [LOCAL] });
    const names = new SessionAgentNames(fake.source);
    names.start();
    await settle();
    expect(names.identityFor(REMOTE.conversationId)).toBeUndefined();

    fake.directoryChanged([REMOTE]);
    expect(names.identityFor(REMOTE.conversationId)).toEqual({ displayName: 'Codex 8', agentUserId: 'agent-d22-uuid' });
    expect(names.identityFor(LOCAL.conversationId)).toEqual({ displayName: 'Claude 3', agentUserId: 'agent-local-uuid' });
  });

  it('目录里早就有、开起来就有的那几条:启动当场收进来', () => {
    const fake = fakeSource({ remote: [REMOTE] });
    const names = new SessionAgentNames(fake.source);
    names.start();
    expect(names.nameFor(REMOTE.conversationId)).toBe('Codex 8');
  });

  it('目录行在、名字后到(身份缓存补取回来):补到就收', () => {
    const fake = fakeSource();
    const names = new SessionAgentNames(fake.source);
    names.start();
    expect(names.identityFor(REMOTE.conversationId)).toBeUndefined();
    fake.identitiesArrived([REMOTE]);
    expect(names.identityFor(REMOTE.conversationId)?.agentUserId).toBe('agent-d22-uuid');
  });

  it('那台机器推来的开户 / 改名事件落表(与本机同一条认领)', async () => {
    const fake = fakeSource();
    const names = new SessionAgentNames(fake.source);
    names.start();
    fake.push({ conversationId: REMOTE.conversationId, displayName: 'Codex 8', agentUserId: REMOTE.agentUserId });
    expect(names.nameFor(REMOTE.conversationId)).toBe('Codex 8');
    fake.push({ conversationId: REMOTE.conversationId, displayName: 'Codex 改名', agentUserId: REMOTE.agentUserId });
    expect(names.nameFor(REMOTE.conversationId)).toBe('Codex 改名');
    fake.push({ conversationId: 'conv-x', displayName: '', agentUserId: 'a' });
    expect(names.identityFor('conv-x')).toBeUndefined();
  });

  it('start 幂等:再调一次不重订阅', () => {
    const fake = fakeSource();
    const onRemote = vi.spyOn(fake.source, 'onRemoteChange');
    const names = new SessionAgentNames(fake.source);
    names.start();
    names.start();
    expect(onRemote).toHaveBeenCalledTimes(1);
  });
});
