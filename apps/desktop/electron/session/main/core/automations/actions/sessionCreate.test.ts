import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateSession } from '@main/core/sessions/hydrateSession';
import { issueController } from '@main/core/issues/controller';
import { openProject } from '@main/core/projects/operations/openProject';
import { projectManager } from '@main/core/projects/project-manager';
import { recordStartFailure } from '@main/core/session-timeline/start-failures';
import { appSettingsService } from '@main/core/settings/settings-service';
import { generateRandom } from '@main/core/sessions/name-generation/generateSessionName';
import {
  commitCreateSession,
  finalizeCreateSession,
  prepareCreateSession,
} from '@main/core/sessions/operations/createSession';
import { sessionService } from '@main/core/sessions/session-service';
import type { Automation } from '@shared/core/automations/automation';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import type { CreateSessionParams } from '@shared/core/sessions/create-session';
import { updateRun } from '../repo';
import type { OnStepCompleted } from '../run-transitions';
import {
  markRunStartingAgent,
  markRunFailed,
  markRunLaunchingSession,
} from '../run-transitions';
import { automationInitialSession, executeSessionCreate } from './sessionCreate';

const { mockAcpStartSession, life } = vi.hoisted(() => ({
  mockAcpStartSession: vi.fn(),
  // session-life (owner of ACP sessions): the launcher admits the creation turns as its first pending rows.
  life: { enqueue: vi.fn((_input: Record<string, unknown>) => ({ seq: 1, state: 'queued' })), start: vi.fn() },
}));
vi.mock('@main/core/sessions/session-life', () => ({ sessionLife: () => life }));

// 起 agent 那一步用的是**真的** launchCreatedSession(与别的机器建会话同一份),只把它按需取的
// 几个重依赖换成桩:读回刚落库的会话行、ACP 启动入参构造、终端腿的首启。
vi.mock('@main/core/sessions/getSessions', () => ({
  // As the real reader maps it: the created row, its creation turns included (the launch admits them from it).
  getSessions: async () => [createdSession()],
}));
vi.mock('@main/embedded-boot', () => ({
  acpStartInputFor: (session: { id: string }, workspaceId: string, cwd: string) => ({
    sessionId: session.id,
    workspaceId,
    cwd,
  }),
}));
vi.mock('@main/core/sessions/hydrateSession', () => ({ hydrateSession: vi.fn() }));
vi.mock('@main/core/session-timeline/start-failures', () => ({ recordStartFailure: vi.fn() }));
vi.mock('@main/core/agents/ensure-agent-installed', () => ({
  isHarnessRuntimeMissing: () => false,
}));
vi.mock('@main/core/projects/operations/ensure-repository-workspace', () => ({
  ensureRepositoryWorkspace: vi.fn().mockResolvedValue('ws-repo-1'),
}));
vi.mock('@main/core/projects/operations/openProject', () => ({ openProject: vi.fn() }));
vi.mock('@main/db/client', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    }),
    transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(mockTx)),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }),
    }),
  },
}));
vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: vi.fn() },
}));
vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: vi.fn() },
}));
vi.mock('@main/core/sessions/name-generation/generateSessionName', () => ({
  generateRandom: vi.fn(() => 'random-task-name'),
}));
vi.mock('@main/core/sessions/operations/createSession', () => ({
  prepareCreateSession: vi.fn(),
  commitCreateSession: vi.fn(),
  finalizeCreateSession: vi.fn(),
}));
vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: { provisionWorkspace: vi.fn() },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), child: vi.fn(() => ({ debug: vi.fn() })) },
}));
vi.mock('@main/core/acp/controller', () => ({
  getAcpRuntimeClient: vi.fn(() => Promise.resolve({ startSession: mockAcpStartSession })),
}));
vi.mock('@main/core/issues/controller', () => ({
  issueController: { getIssueContext: vi.fn() },
}));
vi.mock('../repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../repo')>()),
  updateRun: vi.fn(),
}));
vi.mock('../run-transitions', () => ({
  markRunLaunchingSession: vi.fn(),
  markRunStartingAgent: vi.fn(),
  markRunFailed: vi.fn(),
}));

const mockTx = {
  update: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }),
  }),
};

const automation: Automation = {
  id: 'automation-1',
  name: 'Daily follow-up',
  triggerConfig: { expr: '0 9 * * *', tz: 'UTC' },
  agentConfig: { prompt: 'Check things', provider: 'claude', autoApprove: true },
  sessionConfig: {
    version: '1' as const,
    sessionConfig: {
      version: '1',
      name: 'Stored task',
    },
    workspaceConfig: {
      version: '2' as const,
      workspace: { kind: 'repository-instance' as const, workspaceId: 'ws-1' },
    },
  },
  projectId: 'project-1',
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const run: AutomationRun = {
  id: 'run-1',
  automationId: automation.id,
  scheduledAt: null,
  deadlineAt: null,
  startedAt: 1,
  sessionCreatedAt: null,
  launchedAt: null,
  finishedAt: null,
  status: 'creating_session',
  sessionId: null,
  error: null,
  triggerKind: 'manual',
  triggerConfigSnapshot: { expr: '0 9 * * *', tz: 'UTC' },
  agentConfigSnapshot: { prompt: 'Check things', provider: 'claude', autoApprove: false },
  sessionConfigSnapshot: null,
  generatedSessionName: null,
};

const mockConvRow = { id: 'conv-1' } as never;
const preparedData = {} as never;

const noopStep: OnStepCompleted = vi.fn() as unknown as OnStepCompleted;

/** 交给建任务那一步的会话文档 —— 桌面 composer / 别的机器建会话交的是同一种。 */
function createdSession():
  | NonNullable<CreateSessionParams['sessionConfig']['initialSession']>
  | undefined {
  return vi.mocked(prepareCreateSession).mock.calls[0]?.[0].sessionConfig.initialSession;
}

describe('executeSessionCreate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateRandom).mockReturnValue('random-task-name');
    vi.mocked(appSettingsService.get).mockResolvedValue(null as never);
    vi.mocked(projectManager.getProject).mockReturnValue({} as never);
    vi.mocked(prepareCreateSession).mockResolvedValue({ success: true, data: preparedData });
    vi.mocked(commitCreateSession).mockReturnValue(mockConvRow);
    vi.mocked(finalizeCreateSession).mockReturnValue({ session: { id: 'conv-1' } } as never);
    vi.mocked(sessionService.provisionWorkspace).mockResolvedValue({
      success: true,
      data: { path: '/tmp/session', workspaceId: 'workspace-1' },
    });
    vi.mocked(hydrateSession).mockResolvedValue(undefined as never);
    life.enqueue.mockClear();
    life.start.mockClear();
    mockAcpStartSession.mockResolvedValue({
      success: true,
      data: { providerSessionId: 'acp-session' },
    });
    vi.mocked(issueController.getIssueContext).mockResolvedValue({
      success: false,
      error: { type: 'generic', message: 'not found' },
    });
    vi.mocked(updateRun).mockImplementation(async (_, values) => ({ ...run, ...values }));
    vi.mocked(markRunLaunchingSession).mockResolvedValue({
      ...run,
      status: 'launching_session',
    } as never);
    vi.mocked(markRunStartingAgent).mockResolvedValue({
      ...run,
      status: 'starting_agent',
    } as never);
    vi.mocked(markRunFailed).mockResolvedValue({ ...run, status: 'failed' } as never);
  });

  it('returns err when the prompt is empty', async () => {
    const emptyPromptAutomation = {
      ...automation,
      agentConfig: { prompt: '   ', provider: 'claude', autoApprove: false },
    };
    const result = await executeSessionCreate(emptyPromptAutomation, run, noopStep);
    expect(result).toEqual({ success: false, error: 'task_create_prompt_empty' });
    expect(prepareCreateSession).not.toHaveBeenCalled();
  });

  it('returns err when automation has no projectId', async () => {
    const result = await executeSessionCreate({ ...automation, projectId: undefined }, run, noopStep);
    expect(result).toEqual({ success: false, error: 'no_project_attached' });
    expect(prepareCreateSession).not.toHaveBeenCalled();
  });

  it('marks run failed and returns err when project cannot be opened', async () => {
    vi.mocked(projectManager.getProject).mockReturnValue(undefined);
    vi.mocked(openProject).mockResolvedValue({ success: false, error: 'not_found' as never });

    const result = await executeSessionCreate(automation, run, noopStep);

    expect(result.success).toBe(false);
    expect(markRunFailed).toHaveBeenCalledWith(run.id, {
      step: 'create_session',
      code: 'project_not_found',
    });
    expect(prepareCreateSession).not.toHaveBeenCalled();
  });

  it('marks run failed when launch fails', async () => {
    vi.mocked(sessionService.provisionWorkspace).mockResolvedValue({
      success: false,
      error: {
        type: 'setup-failed',
        stepKind: 'workspace-acquire',
        stepErrorType: 'error',
        message: 'provisioning failed',
      },
    });

    const result = await executeSessionCreate(automation, run, noopStep);

    expect(result.success).toBe(false);
    expect(markRunFailed).toHaveBeenCalledWith(run.id, {
      step: 'launch_session',
      code: 'provision_failed',
      message: 'provisioning failed',
    });
    expect(markRunStartingAgent).not.toHaveBeenCalled();
    expect(hydrateSession).not.toHaveBeenCalled();
    // 会话行已经写下:它照样打得开,没起来的原因记在会话上。
    expect(recordStartFailure).toHaveBeenCalledWith(createdSession()?.id, 'provision_failed');
  });

  it('marks run failed when the agent does not start', async () => {
    vi.mocked(hydrateSession).mockRejectedValue(new Error('conv_failed'));

    const result = await executeSessionCreate(automation, run, noopStep);

    expect(result.success).toBe(false);
    expect(markRunStartingAgent).toHaveBeenCalledWith(run.id, expect.any(Number));
    expect(markRunFailed).toHaveBeenCalledWith(run.id, {
      step: 'start_agent',
      code: 'failed',
      message: 'conv_failed',
    });
    expect(recordStartFailure).toHaveBeenCalledWith(
      createdSession()?.id,
      'session_start_failed'
    );
  });

  it('returns ok with the session id on full success', async () => {
    const result = await executeSessionCreate(automation, run, noopStep);

    expect(result).toEqual({ success: true, data: { sessionId: expect.any(String) } });
    expect(markRunFailed).not.toHaveBeenCalled();
    expect(recordStartFailure).not.toHaveBeenCalled();
  });

  /**
   * #5973 —— 后台自动化**没有第二份默认 Agent**:它跑的那一家就是它自己存的那一家,
   * 所以界面上显示什么、后台就跑什么。
   *
   * ⚠️ 这条钉的是「为什么删掉那两档默认值是安全的」:`assertValidAutomationInput` 要求
   * conversationConfig 里必须有一个已注册、且支持无人值守的 provider,没存 Agent 的自动化
   * 在任何默认值说话**之前**就被挡下了。校验被放松的那天这条会变红,而那正是需要有人
   * 回头想「那时候该挑谁」的时刻。
   */
  it('rejects an automation with no usable stored agent before creating anything', async () => {
    const result = await executeSessionCreate(
      {
        ...automation,
        agentConfig: { prompt: 'Check things', provider: '', autoApprove: true },
      },
      run,
      noopStep
    );

    expect(result).toEqual({
      success: false,
      error: 'automation_provider_unattended_access_unsupported',
    });
    expect(prepareCreateSession).not.toHaveBeenCalled();
  });

  it('passes persisted auto-approval through to Cursor conversations', async () => {
    await executeSessionCreate(
      {
        ...automation,
        agentConfig: { prompt: 'Check things', provider: 'cursor', autoApprove: true },
      },
      run,
      noopStep
    );

    expect(createdSession()).toEqual(
      expect.objectContaining({
        permissionMode: 'full-access',
        provider: 'cursor',
      })
    );
  });

  it('rejects a legacy false value instead of overriding it', async () => {
    const result = await executeSessionCreate(
      {
        ...automation,
        agentConfig: { prompt: 'Check things', provider: 'cursor', autoApprove: false },
      },
      run,
      noopStep
    );

    expect(result).toEqual({ success: false, error: 'automation_auto_approve_required' });
    expect(prepareCreateSession).not.toHaveBeenCalled();
    expect(markRunFailed).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({ message: 'automation_auto_approve_required' })
    );
  });

  it('creates the conversation with the task and starts the ACP leg through the shared launcher', async () => {
    await executeSessionCreate(
      {
        ...automation,
        agentConfig: {
          prompt: 'Check things',
          provider: 'claude',
          autoApprove: true,
          platformModel: { modelId: 'qwen3-coder' },
          effort: 'high',
          type: 'acp',
        },
      },
      run,
      noopStep
    );

    const session = createdSession();
    // 与桌面 composer、别的机器建会话同一份文档:平台模型、权限档、推理档都在,harness 那一格空着。
    expect(session).toEqual(
      expect.objectContaining({
        provider: 'claude',
        type: 'acp',
        platformModel: { modelId: 'qwen3-coder' },
        permissionMode: 'full-access',
        effort: 'high',
        origin: { kind: 'create', firstUtterance: 'Check things' },
        initialQueue: [{ text: 'Check things', origin: 'manual' }],
        title: 'Daily follow-up',
      })
    );
    expect(session?.model).toBeUndefined();
    expect(session?.initialPrompt).toBeUndefined();
    expect(vi.mocked(prepareCreateSession).mock.calls[0]?.[0].automationRunId).toBe(run.id);
    // The shared launcher hands the first sentence to session-life as the session's first pending row; session-life
    // starts it (no direct ACP runtime start, no start-carried initialQueue).
    expect(life.enqueue).toHaveBeenCalledExactlyOnceWith({
      sessionId: session?.id, messageId: `${session?.id}:creation:0`, text: 'Check things', kind: 'ordinary',
      turn: { kind: 'prompt', origin: 'manual' },
    });
    expect(life.start).not.toHaveBeenCalled();
    expect(mockAcpStartSession).not.toHaveBeenCalled();
    expect(hydrateSession).not.toHaveBeenCalled();
  });

  it('hands the terminal leg its first sentence as the startup prompt', async () => {
    await executeSessionCreate(
      {
        ...automation,
        agentConfig: {
          prompt: 'Check things',
          provider: 'claude',
          autoApprove: true,
          model: 'sonnet',
          platformModel: null,
          type: 'pty',
        },
      },
      run,
      noopStep
    );

    const session = createdSession();
    expect(session).toEqual(
      expect.objectContaining({
        type: 'pty',
        model: 'sonnet',
        platformModel: null,
        initialPrompt: 'Check things',
      })
    );
    expect(session?.initialQueue).toBeUndefined();
    expect(hydrateSession).toHaveBeenCalledWith('project-1', session?.id);
    expect(mockAcpStartSession).not.toHaveBeenCalled();
  });
});

describe('automationInitialSession', () => {
  const base = { prompt: 'Check things', provider: 'claude', autoApprove: true } as const;
  const input = { sessionId: 'conv-1', prompt: 'Check things', initialQueue: undefined };

  /**
   * 三态逐字往下传(口径见 SessionPlatformModel):这一维出现之前存下的旧记录**不带**这个字段,
   * 到点时回落 agent 级 —— ❌ 把「没决策过」读成「选了 harness」(那会把原来跑在平台上的定时任务
   * 悄悄改成 BYOK)。
   */
  it('keeps the platform-model decision three-state', () => {
    expect('platformModel' in automationInitialSession(automation, base, input)).toBe(false);
    expect(
      automationInitialSession(automation, { ...base, platformModel: null }, input)
        .platformModel
    ).toBeNull();
    expect(
      automationInitialSession(
        automation,
        { ...base, platformModel: { modelId: 'qwen3-coder' } },
        input
      ).platformModel
    ).toEqual({ modelId: 'qwen3-coder' });
  });

  it('never declares a harness model next to a platform model', () => {
    const session = automationInitialSession(
      automation,
      { ...base, model: 'sonnet', platformModel: { modelId: 'qwen3-coder' } },
      input
    );
    expect(session.model).toBeUndefined();
  });

  it('names the session after the automation unless a title was configured', () => {
    expect(automationInitialSession(automation, base, input).title).toBe('Daily follow-up');
    expect(
      automationInitialSession(automation, { ...base, title: 'Nightly' }, input).title
    ).toBe('Nightly');
  });
});
