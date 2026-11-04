/**
 * 聊天面板腿:会话摘要带来 harness 报的会话记录路径 → 交给终端腿 hook 同一个入口(`learnHarnessConfigRoot`)。
 * 包装器在进程里设的 `CLAUDE_CONFIG_DIR` 宿主看不见,会话记录与预览按那里记下的目录找。
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
vi.mock('../sessions/record-context-usage', () => ({
  readRecordedContextUsage: () => null,
  contextUsageChange: () => null,
  applyContextUsageChange: () => {},
}));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/lib/events', () => ({ events: { emit: () => {} } }));
const learned = vi.hoisted(() => [] as unknown[]);
vi.mock('@main/core/agent-hooks/harness-config-roots', () => ({
  learnHarnessConfigRoot: (input: unknown) => learned.push(input),
}));
vi.mock('./controller', () => ({
  initializeAcpRuntimeProcess: async () => ({
    process: { onExit: () => () => {} },
    client: { sessions: { state: () => ({ value: {} }) } },
  }),
  onAcpRuntimeSpawned: () => () => {},
}));

const SESSION = 'conv-1';
function summary(over: Record<string, unknown>) {
  return {
    sessionId: SESSION,
    projectId: 'project-1',
    providerId: 'claude',
    lifecycle: 'ready',
    isGenerating: false,
    lastTurnOutcome: 'none',
    lastStopReason: null,
    pendingPermissionCount: 0,
    pendingPermissionWaits: [],
    backgroundAgentCount: 0,
    backgroundCommandCount: 0,
    queuedPromptCount: 0,
    title: null,
    updatedAt: 0,
    ...over,
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ACP status bridge learns the harness config root from the reported transcript path', () => {
  beforeEach(() => {
    replicas.length = 0;
    learned.length = 0;
  });

  it('hands each newly reported path to the shared entry, once', async () => {
    vi.resetModules();
    const { acpAgentStatusBridge } = await import('./agent-status-bridge');
    acpAgentStatusBridge.initialize();
    await settle();
    await settle();
    const live = replicas.at(-1)!;
    const push = (over: Record<string, unknown>) => {
      const list = { [SESSION]: summary(over) };
      live.value = list;
      live.onChange?.(list);
    };

    push({});
    expect(learned).toEqual([]);
    const transcriptPath = '/home/u/wrapped-claude-config/projects/-work/abc.jsonl';
    push({ transcriptPath });
    push({ transcriptPath, updatedAt: 1 });
    expect(learned).toEqual([{ sessionId: SESSION, providerId: 'claude', report: { transcript_path: transcriptPath } }]);
    acpAgentStatusBridge.dispose();
  });
});
