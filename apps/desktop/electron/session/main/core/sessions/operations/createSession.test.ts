import { beforeEach, describe, expect, it, vi } from 'vitest';
import { takeBirthGroup } from '@main/core/sessions/birth-groups';
import { createSession } from './createSession';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  getProject: vi.fn(),
  select: vi.fn(),
  recordSessionPlatformModel: vi.fn(async () => {}),
  checkLocalHarnessAvailable: vi.fn(async () => null as unknown),
  resolveProjectFolder: vi.fn(async () => ({ kind: 'root' }) as unknown),
}));

vi.mock('@main/db/client', () => ({
  db: {
    transaction: mocks.transaction,
    select: mocks.select,
  },
}));

// 带 initialConversation 的用例会走到 finalizeCreateSession 的事件广播（需要 electron BrowserWindow）。
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: {
    getProject: mocks.getProject,
  },
}));

// #7341「这个工作区是不是这个项目的文件夹」本身在 project-folders.db.test.ts 里打真库测;这里测的是
// **它说不是时 createSession 做了什么**。
vi.mock('@main/core/projects/operations/project-folders', () => ({
  resolveProjectFolder: mocks.resolveProjectFolder,
}));

// @@@2504 — the post-commit side effects are not under test here; stub the emitters so the
// conversation-insert cases can assert what the transaction writes.
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/core/mcp-library/service', () => ({ mcpLibraryService: { list: async () => [] } }));
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: { emitAgentEvent: vi.fn() },
}));

// @@@5173 引擎可用性判据本身在 resolve-agent-executable.test.ts 里测；这里测的是
// **判据说不可用时 createSession 做了什么**，所以桩掉它并直接给出两种答案。
vi.mock('@main/core/sessions/impl/harness-availability', () => ({
  checkLocalHarnessAvailable: mocks.checkLocalHarnessAvailable,
}));

// @@@2503 composer 的模型选择记在 kv 表(真写库);这个文件测的是事务写了什么,所以只桩掉那一次写,
// 并在下面单独断言它确实被记了。落库语义有 platform-model-selection.db.test.ts 覆盖。
vi.mock('@main/core/sessions/platform-model-selection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordSessionPlatformModel: mocks.recordSessionPlatformModel,
}));

/** 首轮会话:建会话就是建它。 */
const initialSession = {
  id: 'conv-1',
  provider: 'codex',
  title: 'Conversation',
  origin: { kind: 'create' as const, firstUtterance: '开工' },
};

/**
 * Sets up db.transaction to invoke the callback with a fake `tx`.
 * The fake tx captures insert values by call order (workspace if any, then the conversation).
 * Returns an array that is populated with each set of insert values as the callback runs.
 */
function setupTransactionMock() {
  const captured: unknown[] = [];

  mocks.transaction.mockImplementation((cb: (tx: unknown) => void) => {
    captured.length = 0;
    cb({
      insert: () => ({
        values: (vals: unknown) => {
          captured.push(vals);
          return {
            returning: () => ({ all: () => [vals] }),
            run: () => {},
          };
        },
      }),
    });
  });

  return { captured };
}

describe('createTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProject.mockReturnValue({});
    mocks.checkLocalHarnessAvailable.mockResolvedValue(null);
    mocks.resolveProjectFolder.mockResolvedValue({ kind: 'root' });
    setupTransactionMock();
  });

  it('returns project-not-found when project does not exist', async () => {
    mocks.getProject.mockReturnValue(undefined);
    const result = await createSession({
      projectId: 'project-1',
      sessionConfig: { version: '1', name: 'Test Task', initialSession },
      workspaceConfig: {
        version: '2',
        workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
      },
    });
    expect(result).toEqual({ success: false, error: { type: 'project-not-found' } });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  describe('导入本机会话时带上 provider 的会话 id', () => {
    it('把 sessionId 写进 conversation 行（非空 = 首次启动就 resume 原会话）', async () => {
      const { captured } = setupTransactionMock();

      await createSession({
        projectId: 'project-1',
        sessionConfig: {
          version: '1',
          name: '导入的会话',
          initialSession: {
            id: 'conv-1',
            provider: 'codex',
            origin: { kind: 'import', providerSessionId: 'codex-native-session-id' },
            title: '导入的会话',
            type: 'pty',
          },
        },
        workspaceConfig: {
          version: '2',
          workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
        },
      });

      const sessionInsert = captured.at(-1) as Record<string, unknown>;
      expect(sessionInsert.providerSessionId).toBe('codex-native-session-id');
    });

    it('正常创建不带 sessionId（保持「首次启动 = 全新会话」）', async () => {
      const { captured } = setupTransactionMock();

      await createSession({
        projectId: 'project-1',
        sessionConfig: {
          version: '1',
          name: 'Test Task',
          initialSession: {
            id: 'conv-1',
            provider: 'codex',
            title: 'Conversation',
            origin: { kind: 'create', firstUtterance: '开工' },
          },
        },
        workspaceConfig: {
          version: '2',
          workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
        },
      });

      const sessionInsert = captured.at(-1) as Record<string, unknown>;
      expect(sessionInsert.providerSessionId).toBeNull();
    });
  });

  describe('repository-instance workspace target', () => {
    it('reuses the existing workspace ID from config', async () => {
      const { captured } = setupTransactionMock();
      await createSession({
        projectId: 'project-1',
        sessionConfig: { version: '1', name: 'Test Task', initialSession },
        workspaceConfig: {
          version: '2',
          workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
        },
      });

      // Only the conversation row is inserted — no workspace insert.
      expect(captured).toHaveLength(1);
      expect((captured[0] as Record<string, unknown>).workspaceId).toBe('ws-repo-1');
    });

    // #7341 点项目首页里挂上的那个文件夹 ⇒ 会话的工作区就是那个文件夹(会话在它的路径里开工)。
    it('accepts a folder attached to the project and keeps its workspace id', async () => {
      const { captured } = setupTransactionMock();
      mocks.resolveProjectFolder.mockResolvedValue({
        kind: 'attached',
        path: '/work/gugu-7341',
        workspaceKind: 'path',
      });

      const result = await createSession({
        projectId: 'project-1',
        sessionConfig: { version: '1', name: 'Test Task', initialSession },
        workspaceConfig: {
          version: '2',
          workspace: { kind: 'repository-instance', workspaceId: 'ws-attached-1' },
        },
      });

      expect(result.success).toBe(true);
      expect(mocks.resolveProjectFolder).toHaveBeenCalledWith('project-1', 'ws-attached-1');
      expect(captured).toHaveLength(1);
      expect((captured[0] as Record<string, unknown>).workspaceId).toBe('ws-attached-1');
    });

    // ❌ 照抄一个别的项目的工作区 id(会话会跑去那里),❌ 悄悄换成根目录:说出来,一行都不写。
    it('refuses a workspace that is neither the project root nor attached to it, and writes nothing', async () => {
      mocks.resolveProjectFolder.mockResolvedValue(null);

      const result = await createSession({
        projectId: 'project-1',
        sessionConfig: {
          version: '1',
          name: 'Test Task',
          initialSession: { ...initialSession, platformModel: { modelId: 'glm-5.2' } },
        },
        workspaceConfig: {
          version: '2',
          workspace: { kind: 'repository-instance', workspaceId: 'ws-of-project-2' },
        },
      } as never);

      expect(result).toEqual({
        success: false,
        error: {
          type: 'provision-failed',
          message: expect.stringContaining('ws-of-project-2'),
        },
      });
      expect(mocks.resolveProjectFolder).toHaveBeenCalledWith('project-1', 'ws-of-project-2');
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.recordSessionPlatformModel).not.toHaveBeenCalled();
    });

    // 群成员里「新建 Agent」:会话一建好就记下那个群,身份第一次建出来时进群 —— 与 session_spawn 的 chat_id 同一条 birth-groups。
    it('生在群里:记下那个群;不带群就什么都不记', async () => {
      const params = {
        projectId: 'project-1',
        sessionConfig: { version: '1' as const, name: 'Test Task', initialSession },
        workspaceConfig: {
          version: '2' as const,
          workspace: { kind: 'repository-instance' as const, workspaceId: 'ws-repo-1' },
        },
      };
      await createSession({ ...params, birthGroup: { chatId: 'chat-group-1', asTask: true } });
      expect(takeBirthGroup('conv-1')).toEqual({ chatId: 'chat-group-1', asTask: true });
      await createSession(params);
      expect(takeBirthGroup('conv-1')).toBeNull();
    });

  });

  describe('initial conversation agent status', () => {
    const repositoryWorkspace = {
      version: '2',
      workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
    } as const;

    async function createWithInitialSession(
      initialSessionOverrides: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      const { captured } = setupTransactionMock();
      await createSession({
        projectId: 'project-1',
        sessionConfig: {
          version: '1',
          name: 'Test Task',
          initialSession: {
            id: 'conv-1',
            provider: 'claude',
            origin: { kind: 'create', firstUtterance: '开工' },
            ...initialSessionOverrides,
          },
        } as never,
        workspaceConfig: repositoryWorkspace,
      });
      // repository-instance writes no workspace row, so [0]=conversation.
      return captured[0] as Record<string, unknown>;
    }

    // spec session-resume:出生状态由**动词**决定,不是由载荷、也不是由一个开关。
    // ❌ 别改回按 type 分支喂 initialPrompt/initialQueue —— 普通消息走 outbox/router,
    // 照载荷判的地方会静默判成 idle(那次回归实测复现过)。
    it('新建的会话出生即 working(两种形态同一个结果)', async () => {
      for (const type of ['pty', 'acp'] as const) {
        const convInsert = await createWithInitialSession({ type });
        expect(convInsert.agentStatus).toBe('working');
        expect(convInsert.agentStatusSeen).toBe(1);
      }
    });

    it('导入的会话出生即 idle —— 历史在引擎侧,没人在等它回答', async () => {
      const convInsert = await createWithInitialSession({
        type: 'pty',
        origin: { kind: 'import', providerSessionId: 'rollout-1' },
      });
      expect(convInsert.agentStatus).toBe('idle');
    });

    // 载荷在不在**不得**改变出生状态:这条钉的正是「不许从载荷反推」那条边界。
    it('载荷不参与出生状态的判定', async () => {
      const withPayload = await createWithInitialSession({
        type: 'pty',
        initialPrompt: 'fix the failing test',
      });
      const withoutPayload = await createWithInitialSession({ type: 'acp' });
      expect(withPayload.agentStatus).toBe('working');
      expect(withoutPayload.agentStatus).toBe('working');
    });

    // ⬇ 闸:新建不带首轮**建不出来**。这条同时是那道闸的变异对照 ——
    // 把 buildSessionRow 里的 throw 去掉,它必红。
    it('新建不带首轮 ⇒ 当场抛,一行都不写', async () => {
      await expect(
        createWithInitialSession({
          type: 'pty',
          origin: { kind: 'create', firstUtterance: '   \n\t ' },
        })
      ).rejects.toThrow(/必须带首轮/);
    });

    // @@@2503 一个新任务的第一个会话同样由 composer 拍板。记录必须在会话 spawn 之前落下,
    // 否则第一次启动读不到选择 —— 那正是「UI 显示咕咕的模型、实际跑用户自己的 key」。
    it('records the composer platform pick for the initial conversation', async () => {
      await createWithInitialSession({ type: 'pty', platformModel: { modelId: 'glm-5.2' } });
      expect(mocks.recordSessionPlatformModel).toHaveBeenCalledWith('conv-1', { modelId: 'glm-5.2' });
    });

    it('records an explicit harness pick as a decision of its own', async () => {
      // composer 里明确选了「用 Agent 自带的模型」→ 发显式 null → 记下来,启动路径据此一个平台
      // 变量都不注入,即使这个会话的 agent 级 model_access 配着平台模型。
      mocks.recordSessionPlatformModel.mockClear();
      await createWithInitialSession({ type: 'pty', platformModel: null });
      expect(mocks.recordSessionPlatformModel).toHaveBeenCalledWith('conv-1', null);
    });

    it('records nothing for a creation path that has no composer at all', async () => {
      // 自动化任务创建的任务没有 composer。「没人做过决定」≠「决定是 BYOK」—— 记成后者会把这些
      // 会话永久钉死在 BYOK,而它们本该沿用 agent 级默认(改动前的行为)。
      mocks.recordSessionPlatformModel.mockClear();
      await createWithInitialSession({ type: 'pty' });
      expect(mocks.recordSessionPlatformModel).not.toHaveBeenCalled();
    });
  });

});


/**
 * @@@5173 引擎起不来时不要建出一条起不来的会话。
 *
 * 这里的核心断言不是返回了什么错误，而是 **`db.transaction` 一次都没被调用** ——
 * 工作区行、会话行全都在那个事务里，它没跑 = 库里一个字节都没写 = 用户没有需要手动删的东西。
 * 这正是 owner 提的那件事（「没必要多一个无效的会话，我还得手动删」）。
 */
describe('createTask · 引擎不可用', () => {
  // 上面那个 beforeEach 挂在 describe('createSession') 里,兄弟块拿不到 —— 这里自己装一份同样的台子。
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProject.mockReturnValue({});
    mocks.checkLocalHarnessAvailable.mockResolvedValue(null);
    mocks.resolveProjectFolder.mockResolvedValue({ kind: 'root' });
    setupTransactionMock();
  });

  const withInitialSession = {
    projectId: 'project-1',
    sessionConfig: {
      version: '1' as const,
      name: 'Test Task',
      initialSession: {
        id: 'conv-1',
        provider: 'claude',
        initialPrompt: '我发现咕咕的按钮设计, 大小不统一',
      },
    },
    workspaceConfig: {
      version: '2' as const,
      workspace: { kind: 'new-worktree' as const },
    },
  } as unknown as Parameters<typeof createSession>[0];

  it.each([
    ['updating', 'claude is updating: …'],
    ['missing', 'claude not installed: …'],
  ] as const)('does not persist when the harness is unavailable (%s)', async (reason, detail) => {
    mocks.checkLocalHarnessAvailable.mockResolvedValue({
      reason,
      providerId: 'claude',
      harnessName: 'claude',
      detail,
    });

    const result = await createSession(withInitialSession);

    expect(result).toEqual({
      success: false,
      error: {
        type: 'harness-unavailable',
        reason,
        providerId: 'claude',
        harnessName: 'claude',
        detail,
      },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('阳控：引擎可用时照常落库', async () => {
    // 没有这一条，上面两条的 `not.toHaveBeenCalled()` 可能只是因为这个闸把**所有**创建都挡了。
    mocks.checkLocalHarnessAvailable.mockResolvedValue(null);

    const result = await createSession(withInitialSession);

    expect(result.success).toBe(true);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('没有首轮会话就没有可建的东西:当场抛,不问引擎、一行都不写', async () => {
    await expect(
      createSession({
        projectId: 'project-1',
        sessionConfig: { version: '1', name: 'Test Task' },
        workspaceConfig: {
          version: '2',
          workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
        },
      })
    ).rejects.toThrow(/initial agent config/);

    expect(mocks.checkLocalHarnessAvailable).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
