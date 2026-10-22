/**
 * #7199 云电脑醒来那一轮:开机时 ACP 运行时没在就绪预算内起来(冷机,`Runtime did not become ready within 10000ms`),
 * 状态桥只在开机接一次,接失败就再也不接;一秒后会话启动把运行时拉起来、回合照跑,可这台机器上所有 ACP 会话的状态
 * 从此停在原地 —— 会话行一直 idle、lastInteractedAt 不动,设备摘要报 idle,管家把正在干活的机器睡掉。
 * 判据:运行时稍后起来时桥接上它,在跑的那条会话报出开工、做完报出停下;阴控:开机正常时只接一次。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/core/agents/agentEvents';

type FakeReplica = { value: unknown; onChange?: (value: unknown) => void; disposed: boolean };
const replicas: FakeReplica[] = [];

vi.mock('@gugu/session-wire', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gugu/session-wire')>()),
  ReplicaState: class {
    private readonly r: FakeReplica;
    readonly ready = Promise.resolve();
    constructor(handle: { value: unknown }, deps: { onChange?: (value: unknown) => void }) {
      this.r = { value: handle.value, onChange: deps.onChange, disposed: false };
      replicas.push(this.r);
    }
    current() {
      return this.r.value;
    }
    dispose() {
      this.r.disposed = true;
    }
  },
}));

const emitted: AgentEvent[] = [];
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: { emitAgentEvent: (event: AgentEvent) => emitted.push(event) },
}));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({
  agentStatusWriter: { interrupt: async () => {} },
}));
vi.mock('@main/core/agent-hooks/app-focus', () => ({ isAppFocused: () => false }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('../sessions/renameSession', () => ({ applyHarnessTitle: () => {} }));
vi.mock('../sessions/record-context-usage', () => ({
  applyContextUsageChange: () => {},
  contextUsageChange: () => null,
  readRecordedContextUsage: () => null,
}));

const runtime = {
  /** 下一次 `initializeAcpRuntimeProcess()` 的结果:没起来就抛。 */
  up: false,
  stateCalls: 0,
  spawned: new Set<(runtime: object) => void>(),
  process: { onExit: () => () => {} },
  sessions: {} as Record<string, unknown>,
};
vi.mock('./controller', () => ({
  initializeAcpRuntimeProcess: async () => {
    if (!runtime.up) throw new Error('Runtime did not become ready within 10000ms');
    return {
      process: runtime.process,
      client: {
        sessions: {
          state: () => {
            runtime.stateCalls += 1;
            return { value: runtime.sessions };
          },
        },
      },
    };
  },
  onAcpRuntimeSpawned: (listener: (runtime: object) => void) => {
    runtime.spawned.add(listener);
    return () => runtime.spawned.delete(listener);
  },
}));

const SESSION = 'e19e9277-616b-4f0c-a1f3-441ff49e3482';
function summary(lifecycle: 'working' | 'ready', outcome: { lastTurnOutcome: string | null; lastStopReason: string | null }) {
  return {
    sessionId: SESSION,
    projectId: 'project-1',
    providerId: 'claude',
    lifecycle,
    queuedPromptCount: 0,
    pendingPermissionWaits: [],
    backgroundAgentCount: 0,
    backgroundCommandCount: 0,
    title: null,
    ...outcome,
  };
}
const working = () => ({ ...summary('working', { lastTurnOutcome: null, lastStopReason: null }), activeTurnId: 'original-turn' });
const done = () => summary('ready', { lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function freshBridge() {
  vi.resetModules();
  return (await import('./agent-status-bridge')).acpAgentStatusBridge;
}

describe('ACP 状态桥:运行时晚起来也接得上', () => {
  beforeEach(() => {
    replicas.length = 0;
    emitted.length = 0;
    runtime.up = false;
    runtime.stateCalls = 0;
    runtime.spawned.clear();
    runtime.sessions = {};
  });

  it('开机没起来、稍后被会话启动拉起:在跑的那条报出开工,做完报出停下', async () => {
    const bridge = await freshBridge();
    bridge.initialize();
    await settle();
    expect(runtime.stateCalls, '开机那次运行时没起来,没接上任何东西').toBe(0);

    // 会话启动把运行时拉起来,醒来后投进去的那一轮已经在跑。
    runtime.up = true;
    runtime.sessions = { [SESSION]: working() };
    for (const listener of runtime.spawned) listener(runtime.process);
    await settle();
    await settle();
    expect(emitted.filter((e) => e.sessionId === SESSION).map((e) => e.type)).toEqual(['start']);

    const live = replicas.filter((r) => !r.disposed).at(-1)!;
    // endWork commits the transcript first, while lifecycle is still working; the active ID is already cleared.
    live.value = { [SESSION]: { ...working(), activeTurnId: null, lastRecordedTurnId: 'original-turn' } };
    live.onChange?.(live.value);
    live.value = { [SESSION]: { ...done(), activeTurnId: null, lastRecordedTurnId: 'original-turn' } };
    live.onChange?.(live.value);
    expect(emitted.filter((e) => e.sessionId === SESSION).map((e) => e.type)).toEqual(['start', 'stop']);
    expect(emitted.filter((e) => e.sessionId === SESSION).map((e) => e.payload.turnId)).toEqual(['original-turn', 'original-turn']);
    bridge.dispose();
  });

  it('阴控:开机正常时只接一次 —— 同一个运行时起来的通知不再接第二遍', async () => {
    runtime.up = true;
    const bridge = await freshBridge();
    bridge.initialize();
    // 开机那次接的就是这个运行时;它起来的通知随后才到(宿主在 onSpawned 末尾发)。
    for (const listener of runtime.spawned) listener(runtime.process);
    await settle();
    await settle();
    for (const listener of runtime.spawned) listener(runtime.process);
    await settle();
    expect(runtime.stateCalls).toBe(1);
    bridge.dispose();
  });
});
