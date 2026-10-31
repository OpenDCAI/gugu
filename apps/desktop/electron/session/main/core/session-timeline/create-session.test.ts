import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * 设备 RPC 建会话在一台还没装所选 harness 的机器上(#6264 product spec 第 6 条):
 * 先装、再建;装失败就一行都不写、把「装失败」那句人话回给发起方。
 * 建任务那条管线本身(prepare/commit/finalize/launch、ACP 启动、终端腿 hydrate)在别处有覆盖,
 * 这里全换成记账桩,只看「装」这一步在管线里的位置与结果。
 */

const state = vi.hoisted(() => ({
  agentStatus: 'missing' as string,
  calls: [] as string[],
  createParams: [] as Array<{ projectId: string; sessionType?: string }>,
  acpStart: { success: true } as { success: boolean; error?: unknown },
  warnings: [] as Array<Record<string, unknown>>,
  /** 失败原文进日志走一次动态 import(见 create-session.ts logCreateFailure):写进来的那一刻告诉用例。 */
  warned: Promise.withResolvers<void>(),
  failures: new Map<string, string>(),
  startInputs: [] as Array<Record<string, unknown>>,
  hydrateError: null as Error | null,
  /** session-life (owner of ACP sessions): creation turns become pending rows; an empty creation queue is a start. */
  lifeEnqueued: [] as Array<Record<string, unknown>>,
  lifeEnqueueError: null as Error | null,
}));

vi.mock('@main/core/sessions/session-life', () => ({
  sessionLife: () => ({
    enqueue: (input: Record<string, unknown>) => {
      state.calls.push('life.enqueue');
      if (state.lifeEnqueueError) throw state.lifeEnqueueError;
      state.lifeEnqueued.push(input);
      return { seq: state.lifeEnqueued.length, state: 'queued' };
    },
    start: () => { state.calls.push('life.start'); },
  }),
}));

vi.mock('./start-failures', () => ({
  recordStartFailure: (id: string, code: string) => state.failures.set(id, code),
  clearStartFailure: (id: string) => state.failures.delete(id),
  readStartFailure: (id: string) => state.failures.get(id) ?? null,
}));

vi.mock('@main/lib/logger', () => ({
  log: {
    warn: (fields: Record<string, unknown>) => {
      state.warnings.push(fields);
      state.warned.resolve();
    },
  },
}));

vi.mock('@main/db/client', () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [{ id: 'proj-1', repositoryWorkspaceId: 'ws-1' }],
  };
  return {
    db: {
      select: () => chain,
      transaction: (fn: (tx: unknown) => void) => fn({}),
    },
  };
});

// 这台电脑的「终端」开关开着:新任务也照样走通用(owner 10-28)。
vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: async (key: string) => (key === 'terminal' ? { enabled: true } : {}) },
}));
vi.mock('../sessions/platform-model-selection', () => ({ sessionPlatformModel: async () => undefined }));

vi.mock('@main/core/agents/controller', () => ({
  agentsController: {
    list: async () => [
      {
        id: 'codex',
        name: 'Codex',
        status: state.agentStatus,
        capabilities: {
          sessionViews: ['general', 'code'],
          permissionModes: ['plan', 'read-only', 'edit', 'full-access'],
        },
      },
    ],
  },
}));

vi.mock('@shared/core/agents/agent-payload', () => ({
  agentOffersSessionView: (capabilities: { sessionViews: string[] }, view: string) =>
    capabilities.sessionViews.includes(view),
  agentSupportsPermissionMode: (capabilities: { permissionModes: string[] }, mode: string) =>
    capabilities.permissionModes.includes(mode),
}));

vi.mock('@main/core/projects/operations/openProject', () => ({
  openProject: async () => ({ success: true, data: { repositoryWorkspaceId: 'ws-1' } }),
}));

vi.mock('@main/core/projects/operations/project-folders', () => ({
  listProjectFolderRefs: async (projectId: string) => projectId === 'proj-1'
    ? [
        { workspaceId: 'ws-1', kind: 'root', path: '/work/site', attachedAt: null },
        { workspaceId: 'ws-docs', kind: 'attached', path: '/work/docs', attachedAt: '2026-10-20T00:00:00.000Z' },
      ]
    : undefined,
}));

vi.mock('@main/core/sessions/name-generation/generateSessionName', () => ({ generateRandom: () => 'task-name' }));

vi.mock('@main/core/sessions/operations/createSession', () => ({
  prepareCreateSession: async (params: { projectId: string; sessionType?: string }) => {
    state.calls.push('prepareCreateSession');
    state.createParams.push(params);
    return { success: true, data: {} };
  },
  commitCreateSession: () => ({}),
  finalizeCreateSession: () => ({ session: {} }),
}));

vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: {
    provisionWorkspace: async () => ({ success: true, data: { workspaceId: 'ws-1', path: '/tmp/p' } }),
    ensureSessionMounted: async () => ({ workspaceId: 'ws-1', path: '/tmp/p' }),
  },
}));

vi.mock('@main/core/acp/controller', () => ({
  getAcpRuntimeClient: async () => ({
    startSession: async (request: { input: Record<string, unknown> }) => {
      state.calls.push('acp.startSession');
      state.startInputs.push(request.input);
      return state.acpStart;
    },
  }),
}));

vi.mock('@main/core/sessions/session-orchestration', () => ({
  resolveCreateModelChoice: async (_provider: string, _runtime: string, model: string) =>
    ({ model: null, platformModel: { modelId: model.replace(/^platform:/, '') } }),
}));

vi.mock('@main/embedded-boot', () => ({ acpStartInputFor: () => ({}) }));

// The row maps back to a session carrying the creation facts createSession wrote (initialSession config).
vi.mock('@main/core/sessions/getSessions', () => ({
  getSessions: async () => [{
    id: currentSessionId(),
    ...((state.createParams.at(-1) as { sessionConfig?: { initialSession?: Record<string, unknown> } } | undefined)?.sessionConfig?.initialSession ?? {}),
  }],
}));

vi.mock('@main/core/sessions/hydrateSession', () => ({
  hydrateSession: async () => {
    state.calls.push('hydrateSession');
    if (state.hydrateError) throw state.hydrateError;
  },
}));

// createSession 的 conversationId 是 randomUUID —— 让 getSessions 桩认得它。
let lastUuid = '';
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => {
      lastUuid = actual.randomUUID();
      return lastUuid;
    },
  };
});
function currentSessionId(): string {
  return lastUuid;
}

// createModels(#6264):目录探针 + 那台机器的登录读数。
const probe = vi.hoisted(() => ({
  auth: { success: true, data: { kind: 'unauthenticated' } } as unknown,
  authThrows: false,
}));
vi.mock('@main/core/agents/session-discovery', () => ({
  listLocalModels: async () => ({
    harness_id: 'codex',
    transport: 'acp',
    models: [{ id: 'gpt-6-astra', name: 'GPT-6-Astra', source: 'harness' }],
    selected: 'gpt-6-astra',
    efforts: [],
    selected_effort: null,
    harness_catalog: { source: 'live-acp', state: 'ready' },
    gugu_catalog: { available: true },
  }),
  probeHarnessCatalogState: async () => ({ kind: 'ready', models: [], selected: null, efforts: [], selectedEffort: null }),
}));
vi.mock('@main/core/agent-config/runtime-process/host', () => ({
  getAgentConfigRuntimeClient: async () => ({ modelCredential: async () => ({ success: true, data: 'unknown' }) }),
}));
const readAuth = async () => {
  if (probe.authThrows) throw new Error('worker down');
  const result = probe.auth as {
    success: boolean;
    data?: { kind: 'authenticated' | 'unauthenticated' | 'unknown'; reason?: 'expired' };
  };
  return result.success ? result.data ?? null : null;
};

const { createSession, createModels, startSession } = await import('./create-session');
const { AgentInstallFailedError } = await import('@main/core/agents/ensure-agent-installed');

describe('createSession:所选 harness 在这台机器上还没装', () => {
  beforeEach(() => {
    state.agentStatus = 'missing';
    state.calls = [];
    state.createParams = [];
    state.acpStart = { success: true };
    state.warnings = [];
    state.warned = Promise.withResolvers<void>();
    state.lifeEnqueued = [];
    state.lifeEnqueueError = null;
  });

  // #639 后续(owner 10-28):「终端」开关只管终端入口显不显示,新任务没说展示时永远走通用 —— 群里「新任务」卡片交给
  // agent 的那一条也是这样;要编程(终端)的人在会话里再开终端页签。
  it('没说展示:走通用(acp),❌ 跟终端开关进编程', async () => {
    const result = await createSession({ projectId: 'proj-1', harness: 'codex', prompt: 'hi' }, { ensureAgentInstalled: async () => {} });
    expect(result.ok).toBe(true);
    // The ACP leg: the first sentence is the session's first pending row; session-life starts it (no direct runtime start).
    expect(state.calls).toContain('life.enqueue');
    expect(state.calls).not.toContain('acp.startSession');
    expect(state.calls).not.toContain('hydrateSession');
    expect(state.lifeEnqueued).toEqual([{
      sessionId: currentSessionId(), messageId: `${currentSessionId()}:creation:0`, text: 'hi', kind: 'ordinary',
      turn: { kind: 'prompt', origin: 'manual' },
    }]);
    // Its startup outcome is the session's own lifecycle, not this call's answer.
    expect(result.ok && result.value).not.toHaveProperty('startFailure');
  });

  for (const sessionView of ['general', 'code'] as const) {
    it(`${sessionView}:先装(同一个 ensureAgentInstalled),装完再建任务、起会话`, async () => {
      const ensureAgentInstalled = vi.fn(async () => {
        state.calls.push('ensureAgentInstalled');
      });
      const result = await createSession(
        { projectId: 'proj-1', harness: 'codex', prompt: 'hi', sessionView },
        { ensureAgentInstalled }
      );
      expect(result.ok).toBe(true);
      expect(ensureAgentInstalled).toHaveBeenCalledWith('codex');
      expect(state.calls).toEqual([
        'ensureAgentInstalled',
        'prepareCreateSession',
        sessionView === 'general' ? 'life.enqueue' : 'hydrateSession',
      ]);
    });
  }

  // 任务的 type 由 createSession 按项目定(任务工作区 = standalone,项目里 = task),与会话页新建任务同一处;
  // 这里写死 standalone 时,手机 / 远端建在项目里的会话落进侧栏「任务」区、项目下面看不见。
  it('不替 createTask 定任务的 type', async () => {
    await createSession({ projectId: 'proj-1', harness: 'codex', prompt: 'hi', sessionView: 'general' }, { ensureAgentInstalled: async () => {} });
    expect(state.createParams).toEqual([expect.objectContaining({ projectId: 'proj-1' })]);
    expect(state.createParams[0]).not.toHaveProperty('taskType');
  });

  // 手机从群成员里建:请求带的群原样交给建会话那一步(birthGroup),不带就不出现这一格。
  it('请求带了群:交给建会话的 birthGroup(群成员里建的,不是任务座位)', async () => {
    await createSession({ projectId: 'proj-1', harness: 'codex', prompt: 'hi', sessionView: 'general', chatId: 'chat-group-1' }, { ensureAgentInstalled: async () => {} });
    await createSession({ projectId: 'proj-1', harness: 'codex', prompt: 'hi', sessionView: 'general' }, { ensureAgentInstalled: async () => {} });
    expect(state.createParams[0]).toMatchObject({ birthGroup: { chatId: 'chat-group-1', asTask: false } });
    expect(state.createParams[1]).not.toHaveProperty('birthGroup');
  });

  // OpenDCAI/gugu#446 手机在项目里派任务:首句落成那个群里的任务卡(稳定 id 回给手机),agent 坐任务座位。
  it('派任务:首句带上卡的稳定 id 与派出的群,进群坐任务座位,卡的 id 回给发起方', async () => {
    const result = await createSession(
      { projectId: 'proj-1', harness: 'codex', prompt: '修好登录页', sessionView: 'general', chatId: 'chat-project-1', taskChatId: 'chat-project-1' },
      { ensureAgentInstalled: async () => {} }
    );
    expect(result.ok).toBe(true);
    const taskMessageId = result.ok ? result.value.taskMessageId : undefined;
    expect(taskMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.createParams[0]).toMatchObject({
      birthGroup: { chatId: 'chat-project-1', asTask: true },
      sessionConfig: { initialSession: { taskChatId: 'chat-project-1', initialMessageId: taskMessageId, startupOrigin: 'session-page' } },
    });
    // The task's first sentence is admitted under the card's stable id, typed so its gugu message lands first.
    expect(state.lifeEnqueued).toEqual([expect.objectContaining({
      messageId: taskMessageId, text: '修好登录页', turn: { kind: 'chat-page-first-turn' },
    })]);
  });

  it('不派任务:不铸卡的 id,回执里也没有这一格', async () => {
    const result = await createSession({ projectId: 'proj-1', harness: 'codex', prompt: 'hi', sessionView: 'general' }, { ensureAgentInstalled: async () => {} });
    expect(result.ok && result.value).not.toHaveProperty('taskMessageId');
    const initialSession = (state.createParams[0] as unknown as { sessionConfig: { initialSession: Record<string, unknown> } }).sessionConfig.initialSession;
    expect(initialSession).not.toHaveProperty('taskChatId');
    expect(initialSession).not.toHaveProperty('initialMessageId');
  });

  it('cwd:在项目挂的那个文件夹里开工;不是这个项目的文件夹就拒,一行都不写', async () => {
    await createSession({ projectId: 'proj-1', harness: 'codex', prompt: 'hi', sessionView: 'general', cwd: '/work/docs/' }, { ensureAgentInstalled: async () => {} });
    expect(state.createParams[0]).toMatchObject({ workspaceConfig: { workspace: { kind: 'repository-instance', workspaceId: 'ws-docs' } } });
    const rejected = await createSession({ projectId: 'proj-1', harness: 'codex', prompt: 'hi', sessionView: 'general', cwd: '/elsewhere' }, { ensureAgentInstalled: async () => {} });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'folder_not_in_project' } });
    expect(state.createParams).toHaveLength(1);
  });

  it('已经装好:不去装', async () => {
    state.agentStatus = 'available';
    const ensureAgentInstalled = vi.fn(async () => {});
    const result = await createSession({ projectId: 'proj-1', harness: 'codex', prompt: 'hi' }, { ensureAgentInstalled });
    expect(result.ok).toBe(true);
    expect(ensureAgentInstalled).not.toHaveBeenCalled();
  });

  it('装失败:harness_install_failed + 那句人话,任务一行都没建', async () => {
    const ensureAgentInstalled = vi.fn(async () => {
      throw new AgentInstallFailedError('codex', { type: 'unsupported-host', message: 'no mise' });
    });
    const result = await createSession(
      { projectId: 'proj-1', harness: 'codex', prompt: 'hi', sessionView: 'code' },
      { ensureAgentInstalled }
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'harness_install_failed', message: expect.stringContaining('在这台机器上安装 codex 失败') },
    });
    expect(state.calls).not.toContain('prepareCreateSession');
  });

  it('装的那一步抛了别的异常(探测失败之类):同一个码、同一句开头,❌ 不是裸错误', async () => {
    const ensureAgentInstalled = vi.fn(async () => {
      throw new Error('probe exploded');
    });
    const result = await createSession({ projectId: 'proj-1', harness: 'codex', prompt: 'hi' }, { ensureAgentInstalled });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'harness_install_failed', message: expect.stringMatching(/安装 codex 失败.*probe exploded/) },
    });
  });
});

describe('createSession:会话行写下之后 agent 没起来(#6264 会话照样打得开)', () => {
  beforeEach(() => {
    state.agentStatus = 'available';
    state.calls = [];
    state.warnings = [];
    state.warned = Promise.withResolvers<void>();
    state.failures.clear();
    state.hydrateError = null;
    state.lifeEnqueued = [];
    state.lifeEnqueueError = null;
  });

  // Retargeted to the terminal leg (sessionView code → hydrate): an ACP startup failure is now session-life's failed
  // state and never comes back through createSession; the classification still applies where the start is synchronous.
  it('适配器模块解析不到:照常返回会话(带原因码 harness_runtime_missing),原因码记在这台机器上,原文只进日志', async () => {
    const raw = "Cannot find module '@agentclientprotocol/claude-agent-acp/dist/index.js'\nRequire stack:\n- /home/a/.gugu-server/versions/0.2.113/app/dist-electron/registry-x.js";
    state.hydrateError = new Error(raw);
    const result = await createSession(
      { projectId: 'proj-1', harness: 'codex', prompt: 'hi', sessionView: 'code' },
      { ensureAgentInstalled: async () => {} }
    );
    expect(result).toMatchObject({ ok: true, value: { conversationId: currentSessionId(), startFailure: 'harness_runtime_missing' } });
    expect(JSON.stringify(result)).not.toMatch(/Cannot find module|Require stack|dist-electron/);
    expect(state.failures.get(currentSessionId())).toBe('harness_runtime_missing');
    await state.warned.promise;
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]).toMatchObject({ code: 'harness_runtime_missing', detail: expect.stringContaining(raw.split('\n')[0]) });
  });

  it('选了咕咕提供的模型、签平台额度那一趟连不上:原因码 platform_model_unreachable,❌ 把网关那句原文回给发起方', async () => {
    const raw = 'error sending request for url (http://gugu-newapi:3000/api/status): client error (Connect): dns error';
    state.hydrateError = new Error(raw);
    const result = await createSession(
      { projectId: 'proj-1', harness: 'codex', prompt: 'hi', sessionView: 'code', model: 'platform:gpt-x' },
      { ensureAgentInstalled: async () => {} }
    );
    expect(result).toMatchObject({ ok: true, value: { startFailure: 'platform_model_unreachable' } });
    expect(JSON.stringify(result)).not.toContain('gugu-newapi');
  });

  // ACP: the only synchronous start failure left is session-life refusing the admission itself.
  it('别的起不来原因:照常返回会话,原因码 session_start_failed', async () => {
    state.lifeEnqueueError = new Error('spawn EACCES');
    const result = await createSession(
      { projectId: 'proj-1', harness: 'codex', prompt: 'hi', sessionView: 'general' },
      { ensureAgentInstalled: async () => {} }
    );
    expect(result).toMatchObject({ ok: true, value: { startFailure: 'session_start_failed' } });
  });

  it('会话行写下之前的失败仍然留在新建页:原文进日志', async () => {
    const result = await createSession(
      { projectId: 'proj-1', harness: 'nope', prompt: 'hi' },
      { ensureAgentInstalled: async () => {} }
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'harness_not_found' } });
    await state.warned.promise;
    expect(state.warnings).toHaveLength(1);
  });
});

describe('startSession:再试一次', () => {
  beforeEach(() => {
    state.calls = [];
    state.warnings = [];
    state.warned = Promise.withResolvers<void>();
    state.failures.clear();
    state.hydrateError = null;
  });

  it('起来了:清掉记着的原因码', async () => {
    state.failures.set('proj-1', 'session_start_failed');
    await expect(startSession('proj-1')).resolves.toEqual({ ok: true, value: { started: true } });
    expect(state.calls).toContain('hydrateSession');
    expect(state.failures.has('proj-1')).toBe(false);
  });

  it('还是起不来:报原因码、记下来', async () => {
    state.hydrateError = new Error('Not logged in · Please run /login');
    await expect(startSession('proj-1')).resolves.toMatchObject({ ok: false, error: { code: 'agent_signed_out' } });
    expect(state.failures.get('proj-1')).toBe('agent_signed_out');
  });
});

describe('createModels:那台机器上这家登没登(#6264 探针漏判)', () => {
  beforeEach(() => {
    state.agentStatus = 'available';
    probe.authThrows = false;
  });

  it('目录探针说 ready,登录读数照实报「没登录」—— 两个读数各说各的', async () => {
    // codex 经 app-server 没登录也列得出自家目录(实测 CODEX_HOME 为空时 session/new 照样回 7 个模型)。
    probe.auth = { success: true, data: { kind: 'unauthenticated' } };
    const result = await createModels({ harness: 'codex', sessionView: 'general' }, { readAuth });
    expect(result).toMatchObject({ ok: true, value: { harnessState: 'ready', harnessAuth: 'signed-out' } });
  });

  it('#6264 登录已失效:signed-out 并带 harnessAuthExpired;普通没登录不带', async () => {
    probe.auth = { success: true, data: { kind: 'unauthenticated', reason: 'expired' } };
    expect(await createModels({ harness: 'codex' }, { readAuth })).toMatchObject({
      ok: true,
      value: { harnessAuth: 'signed-out', harnessAuthExpired: true },
    });
    probe.auth = { success: true, data: { kind: 'unauthenticated' } };
    const plain = await createModels({ harness: 'codex' }, { readAuth });
    expect(plain.ok && plain.value).not.toHaveProperty('harnessAuthExpired');
  });

  it('登上了 = signed-in;读不出 = unknown(界面维持原判断)', async () => {
    probe.auth = { success: true, data: { kind: 'authenticated', account: 'alice' } };
    expect(await createModels({ harness: 'codex' }, { readAuth })).toMatchObject({ ok: true, value: { harnessAuth: 'signed-in' } });
    probe.auth = { success: false, error: { type: 'unknown-provider', providerId: 'codex' } };
    expect(await createModels({ harness: 'codex' }, { readAuth })).toMatchObject({ ok: true, value: { harnessAuth: 'unknown' } });
    probe.authThrows = true;
    expect(await createModels({ harness: 'codex' }, { readAuth })).toMatchObject({ ok: true, value: { harnessAuth: 'unknown' } });
  });
});
