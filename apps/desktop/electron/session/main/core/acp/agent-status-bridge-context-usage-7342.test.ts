/**
 * #7342 状态桥把最后那份上下文读数记进会话记录 —— 性能那一半的合同:
 * 摘要每个 token 都来一份,而库只在**第一次见到这条会话时读一次**、**每轮落定写一次**;
 * 换了模型作废一次;会话停掉(摘要消失)就忘掉影子,下次起来重读。
 * 判据本身(写 / 作废 / 不动)在 record-context-usage.db.test.ts,这里用真的那一份。
 * 能判假:去掉桥里的影子、每份摘要都读库,前两条当场红(mac1 实测)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeReplica = { value: unknown; onChange?: (value: unknown) => void };
const replicas: FakeReplica[] = [];

vi.mock('@gugu/session-wire', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gugu/session-wire')>()),
  ReplicaState: class {
    private readonly r: FakeReplica;
    readonly ready = Promise.resolve();
    constructor(handle: { value: unknown }, deps: { onChange?: (value: unknown) => void }) {
      this.r = { value: handle.value, onChange: deps.onChange };
      replicas.push(this.r);
    }
    current() {
      return this.r.value;
    }
    dispose() {}
  },
}));
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({ agentHookService: { emitAgentEvent: () => {} } }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { interrupt: async () => {} } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('../sessions/renameSession', () => ({ applyHarnessTitle: () => {} }));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/lib/events', () => ({ events: { emit: () => {} } }));

const store = vi.hoisted(() => ({
  reads: [] as string[],
  writes: [] as Array<{ sessionId: string; change: unknown }>,
  recorded: null as unknown,
}));
vi.mock('../sessions/record-context-usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessions/record-context-usage')>()),
  readRecordedContextUsage: (sessionId: string) => {
    store.reads.push(sessionId);
    return store.recorded;
  },
  applyContextUsageChange: (sessionId: string, change: unknown) => store.writes.push({ sessionId, change }),
}));

vi.mock('./controller', () => ({
  initializeAcpRuntimeProcess: async () => ({
    process: { onExit: () => () => {} },
    client: { sessions: { state: () => ({ value: {} }) } },
  }),
  onAcpRuntimeSpawned: () => () => {},
}));

const SESSION = 'conv-7342';
function summary(over: Record<string, unknown>) {
  return {
    sessionId: SESSION,
    projectId: 'project-1',
    providerId: 'codex',
    lifecycle: 'ready',
    isGenerating: false,
    lastTurnOutcome: 'stopped',
    lastStopReason: 'end_turn',
    pendingPermissionCount: 0,
    pendingPermissionWaits: [],
    backgroundAgentCount: 0,
    backgroundCommandCount: 0,
    queuedPromptCount: 0,
    title: null,
    contextTokens: null,
    contextSize: null,
    contextModelId: null,
    modelId: 'gpt-5.5',
    updatedAt: 0,
    ...over,
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function attachedBridge() {
  vi.resetModules();
  const { acpAgentStatusBridge } = await import('./agent-status-bridge');
  acpAgentStatusBridge.initialize();
  await settle();
  await settle();
  const live = replicas.at(-1)!;
  const push = (list: Record<string, unknown>) => {
    live.value = list;
    live.onChange?.(list);
  };
  return { bridge: acpAgentStatusBridge, push };
}

describe('#7342 状态桥记上下文读数', () => {
  beforeEach(() => {
    replicas.length = 0;
    store.reads.length = 0;
    store.writes.length = 0;
    store.recorded = null;
  });

  it('流式中一个字都不写;一轮落定写一次;同一份再来不再写;库只读一次', async () => {
    const { bridge, push } = await attachedBridge();
    const reading = { contextTokens: 40_000, contextSize: 200_000, contextModelId: 'gpt-5.5' };
    for (let tokens = 30_000; tokens < 40_000; tokens += 1_000) {
      push({ [SESSION]: summary({ lifecycle: 'working', isGenerating: true, ...reading, contextTokens: tokens }) });
    }
    expect(store.writes, '流式中写库 = 每个 token 一次事务 + 一次全窗口广播').toEqual([]);

    push({ [SESSION]: summary(reading) });
    push({ [SESSION]: summary({ ...reading, updatedAt: 1 }) });
    push({ [SESSION]: summary({ ...reading, updatedAt: 2 }) });
    expect(store.writes).toEqual([
      { sessionId: SESSION, change: { kind: 'write', reading: { used: 40_000, size: 200_000, modelId: 'gpt-5.5' } } },
    ]);
    expect(store.reads, '影子在内存里:同一条会话的库只读第一次').toEqual([SESSION]);

    // 下一轮读数变了:再写一次。
    push({ [SESSION]: summary({ ...reading, contextTokens: 52_000 }) });
    expect(store.writes).toHaveLength(2);
    bridge.dispose();
  });

  it('热切之后:记录里旧模型那份作废一次,新读数到了再写', async () => {
    store.recorded = { used: 40_000, size: 200_000, modelId: 'gpt-5.5' };
    const { bridge, push } = await attachedBridge();
    const old = { contextTokens: 40_000, contextSize: 200_000, contextModelId: 'gpt-5.5' };
    push({ [SESSION]: summary({ ...old, modelId: 'gpt-5.5-mini' }) });
    push({ [SESSION]: summary({ ...old, modelId: 'gpt-5.5-mini', updatedAt: 1 }) });
    expect(store.writes.map((w) => w.change)).toEqual([{ kind: 'clear' }]);

    push({ [SESSION]: summary({ contextTokens: 41_000, contextSize: 128_000, contextModelId: 'gpt-5.5-mini', modelId: 'gpt-5.5-mini' }) });
    expect(store.writes.map((w) => w.change)).toEqual([
      { kind: 'clear' },
      { kind: 'write', reading: { used: 41_000, size: 128_000, modelId: 'gpt-5.5-mini' } },
    ]);
    bridge.dispose();
  });

  it('会话停掉(摘要消失)就忘掉影子:下次起来从库里重读', async () => {
    const { bridge, push } = await attachedBridge();
    push({ [SESSION]: summary({}) });
    push({});
    push({ [SESSION]: summary({}) });
    expect(store.reads).toEqual([SESSION, SESSION]);
    bridge.dispose();
  });
});
