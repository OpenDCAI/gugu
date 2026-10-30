import { beforeEach, describe, expect, it, vi } from 'vitest';

// @@@replica-failed-ready — 一次拿好几份副本的 create():其中一份的 `ready` 拒了,调用方收到的是错误、拿不到那个
// 对象,于是已经接上的另外几份再也没人拆。判据是结构量:失败以后还没 dispose 的副本数、起了的登录有没有被取消。
// 副本换成只记账的假类 —— 这里验的是 create() 的收尾,副本自己的放手由 session-wire 的 release.test.ts 钉着。

type FakeReplica = { topic: string; disposed: boolean };
const hoisted = vi.hoisted(() => ({
  replicas: [] as FakeReplica[],
  failingTopics: new Set<string>(),
  cancelLogin: { calls: 0 },
}));

vi.mock('@gugu/session-wire', async (importOriginal) => {
  class FakeReplicaBase {
    readonly ready: Promise<void>;
    private readonly record: FakeReplica;
    constructor(handle: { topic: string }) {
      this.record = { topic: handle.topic, disposed: false };
      hoisted.replicas.push(this.record);
      this.ready = hoisted.failingTopics.has(handle.topic)
        ? Promise.reject(new Error(`snapshot failed: ${handle.topic}`))
        : Promise.resolve();
      this.ready.catch(() => {});
    }
    current(): unknown {
      return {};
    }
    onChange(): () => void {
      return () => {};
    }
    async dispose(): Promise<void> {
      this.record.disposed = true;
    }
  }
  return {
    ...(await importOriginal<typeof import('@gugu/session-wire')>()),
    ReplicaState: FakeReplicaBase,
    ReplicaLog: FakeReplicaBase,
  };
});
vi.mock('../machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('./runtime-client', () => ({
  getAcpRuntimeClient: async () => ({
    session: { state: (_key: unknown, name: string) => ({ topic: `session.${name}` }) },
  }),
}));
vi.mock('../agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    startLogin: async () => ({ success: true, data: undefined }),
    cancelLogin: async () => {
      hoisted.cancelLogin.calls += 1;
      return { success: true, data: undefined };
    },
    agents: { state: () => ({ topic: 'agents.list' }) },
    loginOutput: { handle: () => ({ topic: 'loginOutput' }) },
  }),
}));
vi.mock('../pty/xterm-log-sink', () => ({ createXtermLogSink: () => ({ reset: () => {}, append: () => {} }) }));
const { AcpLiveSession } = await import('./acp-live-session');
const { AcpAuthLoginBinding } = await import('./auth-login-binding');

const undisposed = () => hoisted.replicas.filter((replica) => !replica.disposed).map((replica) => replica.topic);

beforeEach(() => {
  hoisted.replicas.length = 0;
  hoisted.failingTopics.clear();
  hoisted.cancelLogin.calls = 0;
});

describe('create() that fails on one replica releases the ones it already holds', () => {
  it('AcpLiveSession: one of the live models fails → all eight are disposed', async () => {
    hoisted.failingTopics.add('session.plan');

    await expect(AcpLiveSession.create('conv')).rejects.toThrow('snapshot failed: session.plan');

    expect(hoisted.replicas).toHaveLength(8);
    expect(undisposed()).toEqual([]);
  });

  it('AcpLiveSession: every model ready → nothing is disposed (positive control)', async () => {
    const session = await AcpLiveSession.create('conv');
    expect(undisposed()).toHaveLength(8);
    session.dispose();
    expect(undisposed()).toEqual([]);
  });

  it('AcpAuthLoginBinding: the login output fails → the status replica is disposed and the started login is cancelled', async () => {
    hoisted.failingTopics.add('loginOutput');

    await expect(
      AcpAuthLoginBinding.create({
        providerId: 'claude',
        methodId: 'oauth',
        terminal: { reset: () => {}, write: () => {} },
      })
    ).rejects.toThrow('snapshot failed: loginOutput');

    expect(hoisted.replicas.map((replica) => replica.topic)).toEqual(['agents.list', 'loginOutput']);
    expect(undisposed()).toEqual([]);
    expect(hoisted.cancelLogin.calls).toBe(1);
  });
});
