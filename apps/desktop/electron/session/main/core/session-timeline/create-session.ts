import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { DEFAULT_SESSION_VIEW } from '@shared/core/sessions/new-session-defaults';
import {
  GUGU_PERMISSION_MODES,
  type GuguPermissionMode,
} from '@gugu/session-core/acp';
import {
  type SessionpageAgentAuthState,
  type SessionpageHarnessOption,
  type SessionpageSessionCreateLastUsed,
  type SessionpageSessionCreateModels,
  type SessionpageSessionCreateModelsRequest,
  type SessionpageSessionCreateOptions,
  type SessionpageSessionCreateRequest,
  type SessionpageSessionCreateResult,
  type SessionpageSessionView,
} from '@gugu/session-core/session-record/contract';
import { db } from '@main/db/client';
import { readProjects } from '@main/core/projects/operations/getProjects';
import { sessions, projects } from '@main/db/schema';
import type { SessionRow } from '@main/db/schema';
import {
  agentOffersSessionView,
  agentSupportsPermissionMode,
  type AgentPayload,
} from '@shared/core/agents/agent-payload';
import { platformEffortFacts, resolveCreateEfforts } from '@shared/core/agents/create-efforts';
import { SESSION_VIEWS, sessionRuntimeOfView, sessionpageLegOfView } from '@shared/core/sessions/sessions';
import { buildInitialSessionDocument } from '@shared/core/sessions/initial-session-document';
import type { CreateSessionParams } from '@shared/core/sessions/create-session';
import {
  AgentInstallFailedError,
  describeAgentInstallFailure,
  describeHarnessRuntimeMissing,
  ensureAgentInstalled,
  HARNESS_RUNTIME_MISSING_CODE,
} from '@main/core/agents/ensure-agent-installed';
import { sessionPlatformModel } from '../sessions/platform-model-selection';
import { lastUsedFromSession } from './create-session-last-used';
import { classifyCreateFailure } from './create-failure';
import { launchCreatedSession } from './launch-created-session';
import { sessionRecordHarnessForProvider } from './locate';
import { clearStartFailure, recordStartFailure } from './start-failures';

/**
 * 手机在**这台机器上**开一条新会话。
 *
 * ⚠️ 这是手机端第一条会真正拉起进程的通道。在它之前,手机只能读、只能往已存在的会话里说话;
 * 从这里开始,一次点击会在 owner 的机器上建仓外目录之外的东西、起一个 agent 进程。所以:
 *
 *   · **一个定义,两个入口**(owner 2026-09-15:「手机端和电脑端要两套维护,没必要」)。
 *     一次创建有哪几维(展示 / 权限档 / 模型 / 推理档 / 第一句话)只在
 *     `@shared/core/sessions/initial-session-document` 那一份输入类型里;桌面 composer 与
 *     这里都把各自的选择交给同一个 `buildInitialSessionDocument`,产出的文档走同一条
 *     `prepareCreateSession → commitCreateSession → finalizeCreateSession → provisionWorkspace` 管线落成会话行。
 *     可选项也用桌面同一组判定:展示看 `agentOffersSessionView`,权限档看 `agentSupportsPermissionMode`,
 *     模型/推理档走 `listLocalModels`(与 session_list_models 同一份目录)。
 *     ❌ 不在这里另拼一条会话行(以前用 attachAgentToSession 手拼过一份 —— 那就是第二个创建器,
 *     权限档/推理档/展示三维在那份里根本没有位置,手机端于是「只能选 harness」)。
 *   · **工作区不让手机选**:任务就跑在项目自己的工作树里(`workspace-config.ts` 的注释写着
 *     产品从不开 worktree、也不建任务分支)。
 *   · **空提示词不建**:一条没有开场白的会话建出来就是个空壳,而它已经占了一个 agent 进程。
 */

export type CreateSessionFailure = { code: string; message: string };
export type CreateSessionResult<T> = { ok: true; value: T } | { ok: false; error: CreateSessionFailure };

function fail(code: string, message: string): CreateSessionResult<never> {
  return { ok: false, error: { code, message } };
}

/**
 * 起这家 agent 的路上失败。原文是「模块解析不到」时(这台机器上的咕咕缺适配器,#6264),
 * 发起方拿到的是一句能照做的人话和它自己的错误码,❌ 不是 `Cannot find module …` 加一整段 require 栈;
 * 原文进这台机器的日志。其余原因照旧逐字回传。
 */
function failStart(code: string, detail: string, provider: string, platformModel = false): CreateSessionResult<never> {
  const classified = classifyCreateFailure(code, detail, { platformModel });
  if (classified === HARNESS_RUNTIME_MISSING_CODE) {
    return fail(HARNESS_RUNTIME_MISSING_CODE, describeHarnessRuntimeMissing(provider));
  }
  return fail(classified, detail);
}

/** 原文进这台机器的日志(发起方只拿原因码,按它自己的界面语言说人话)。 */
function logCreateFailure(fields: Record<string, unknown>, detail: string): void {
  void import('@main/lib/logger').then(({ log }) =>
    log.warn({ scope: 'session-timeline/create', ...fields, detail }, '在这台机器上建会话/起会话失败'),
  );
}

/*
 * ⚠️ **用时再取**,❌ 不在模块顶层 import。
 * `agents/controller` 会把 secrets / electron 那一整片依赖图一起拖进来,而这个文件挂在
 * 设备 RPC 上 —— 顶层 import 的后果是:凡是加载设备 RPC 的地方(包括它自己的单测)都得先
 * 把 electron 的 safeStorage 备齐,否则模块加载期就炸(实测 `No "safeStorage" export is
 * defined on the "electron" mock`,报的是加载失败,看着像测试写错了)。
 * 这些函数都只在人点开新建页之后才跑,晚一点点取毫无代价。
 */
async function agentPayloads(): Promise<AgentPayload[]> {
  const { agentsController } = await import('@main/core/agents/controller');
  return agentsController.list();
}

/** 这家给哪几种展示 —— 桌面新建面同一份判定;通用在前(手机看会话看的正是聊天腿的结构化记录)。 */
function offeredSessionViews(agent: AgentPayload): SessionpageSessionView[] {
  return (['general', 'code'] as const).filter((view) => agentOffersSessionView(agent.capabilities, view));
}

/**
 * 这家声明过的咕咕权限档,从严到松 —— 桌面新建面同一份判定(按腿);没声明就空,界面不摆。
 * 手机这一格按 harness 列、不分展示 ⇒ 只列它给的**每一种**展示都兑现得了的档(antigravity 的只读只在聊天面板腿,
 * 两种展示都给 ⇒ 不列),选了也不会在建会话时被那一腿拒掉。
 */
function declaredPermissionModes(agent: AgentPayload): GuguPermissionMode[] {
  const legs = offeredSessionViews(agent).map(sessionpageLegOfView);
  return GUGU_PERMISSION_MODES.filter((mode) =>
    legs.length === 0
      ? agentSupportsPermissionMode(agent.capabilities, mode)
      : legs.every((leg) => agentSupportsPermissionMode(agent.capabilities, mode, leg)));
}

/**
 * 那台机器上可选的 harness。
 *
 * 走的是桌面 composer 用的**同一个** `agents.list` —— ❌ 不在这里另算一份「装没装」:
 * 两处各算一次,手机和桌面迟早会对同一台机器给出不同答案。
 * 状态**原样带过去**(`available` / `missing` / `error`);不能用的也照报,❌ 不静默过滤。
 */
async function harnessOptions(): Promise<SessionpageHarnessOption[]> {
  const payloads = await agentPayloads();
  return payloads.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    reading: agent.reading,
    watchable: sessionRecordHarnessForProvider(agent.id) !== null,
    sessionViews: offeredSessionViews(agent),
    permissionModes: declaredPermissionModes(agent),
  }));
}

export async function createOptions(): Promise<CreateSessionResult<SessionpageSessionCreateOptions>> {
  try {
    const rows = readProjects().map(({ id, name, path }) => ({ id, name, path }));
    /*
     * 最近用过的项目排最前 —— 手机端默认选第一个,而人多半是想接着刚才那个项目干。
     * 真机实测按建表顺序排时,第一个永远是内置的「任务工作区」(id 固定、最早建),
     * 于是默认落进一个空目录;人得先点开胶囊换项目,而他上一条会话明明就在「验收工作区」。
     * 「最近」= 该项目下会话最后一次交互(没有就取更新时间);一条会话都没有的排最后。
     */
    const recent = await db
      .select({
        projectId: sessions.projectId,
        last: sql<string | null>`max(coalesce(${sessions.lastInteractedAt}, ${sessions.updatedAt}))`,
      })
      .from(sessions)
      .groupBy(sessions.projectId)
      .all();
    const lastUsed = new Map(recent.map((r) => [r.projectId, r.last ?? '']));
    const ordered = [...rows].sort((a, b) => (lastUsed.get(b.id) ?? '').localeCompare(lastUsed.get(a.id) ?? ''));
    return {
      ok: true,
      value: { projects: ordered, harnesses: await harnessOptions(), lastUsed: await lastUsedCreateSelection() },
    };
  } catch (error) {
    return fail('create_options_failed', (error as Error)?.message ?? String(error));
  }
}

/**
 * 这台机器上最近一次**新建**的会话用的那一套(按建立时间从新往旧找第一条算数的,见 `lastUsedFromSession`)。
 * 桌面开的、手机开的都在这张表里,所以两端沿用的是同一份「上次」。
 */
async function lastUsedCreateSelection(): Promise<SessionpageSessionCreateLastUsed | null> {
  const rows = await db
    .select({
      id: sessions.id,
      projectId: sessions.projectId,
      provider: sessions.provider,
      config: sessions.config,
      parentSessionId: sessions.parentSessionId,
    })
    .from(sessions)
    .where(isNull(sessions.parentSessionId))
    .orderBy(desc(sessions.createdAt))
    .all();
  for (const row of rows) {
    if (!lastUsedFromSession(row, undefined)) continue;
    return lastUsedFromSession(row, await sessionPlatformModel(row.id));
  }
  return null;
}

async function findAgent(harness: string): Promise<AgentPayload | null> {
  return (await agentPayloads()).find((agent) => agent.id === harness) ?? null;
}

/**
 * 请求没说展示就走通用(这家不给通用就取它给的第一种);说了就必须在它给的里面。
 * 「终端」开关只管终端入口显不显示,❌ 决定新任务的展示(owner 10-28:开着也默认通用,终端是会话里多一个页签)。
 */
async function resolveSessionView(
  agent: AgentPayload,
  requested: SessionpageSessionView | undefined,
): Promise<{ ok: true; view: SessionpageSessionView } | { ok: false; message: string }> {
  const offered = offeredSessionViews(agent);
  if (offered.length === 0) return { ok: false, message: `${agent.id} 在这台机器上一种展示都接不通` };
  if (!requested) return { ok: true, view: offered.includes(DEFAULT_SESSION_VIEW) ? DEFAULT_SESSION_VIEW : offered[0]! };
  if (!SESSION_VIEWS.includes(requested) || !offered.includes(requested)) {
    return { ok: false, message: `${agent.id} 不提供「${requested}」这种展示` };
  }
  return { ok: true, view: requested };
}

/**
 * 选定 harness × 展示 在这台机器上能跑哪些模型 —— 走 `session_list_models` **同一条**目录路
 * (`listLocalModels`),两组并一份、同一套 `platform:` 编码。❌ 不另算:桌面下拉、agent 的
 * session_list_models、手机新建页三处对同一台机器必须给出同一份清单。
 */
/** 读不出来一律 `unknown`(维持这家自家默认),与渲染层 useHarnessModelCredential 同一条退化。 */
async function readSelectedCredential(
  providerId: string,
  modelId: string,
): Promise<'credentialed' | 'uncredentialed' | 'unknown'> {
  try {
    const { getAgentConfigRuntimeClient } = await import('@main/core/agent-config/runtime-process/host');
    const runtime = await getAgentConfigRuntimeClient();
    const result = await runtime.modelCredential({ providerId, modelId });
    return result.success ? result.data : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 这家在这台机器上登没登(#6264)—— 与桌面「账号」那一行同一个读数(worker 的 refreshAuthStatus,
 * 跑会话会用的那份 CLI 与配置根)。模型目录探针答不了这件事:codex 经 app-server 没登录也列得出自家目录。
 * 读不出一律 `unknown`(界面维持原判断)。
 */
async function readHarnessAuth(
  providerId: string,
  readAuth: CreateModelsDeps['readAuth']
): Promise<{ state: SessionpageAgentAuthState; expired: boolean }> {
  try {
    const reading = await readAuth(providerId);
    if (!reading) return { state: 'unknown', expired: false };
    const state: SessionpageAgentAuthState =
      reading.kind === 'authenticated' ? 'signed-in' : reading.kind === 'unauthenticated' ? 'signed-out' : 'unknown';
    // #6264 登录已失效:凭据文件还在,但这家最近一次真用时被拒了 —— 界面说「重新登录」。
    return { state, expired: reading.kind === 'unauthenticated' && reading.reason === 'expired' };
  } catch {
    return { state: 'unknown', expired: false };
  }
}

export interface CreateModelsDeps {
  /** 这家在这台机器上的登录读数(worker 的 refreshAuthStatus);读不出返回 null 或抛。 */
  readAuth: (
    providerId: string
  ) => Promise<{ kind: 'authenticated' | 'unauthenticated' | 'unknown'; reason?: 'expired' } | null>;
}

const defaultCreateModelsDeps: CreateModelsDeps = {
  readAuth: async (providerId) => {
    const { getAgentConfigRuntimeClient } = await import('@main/core/agent-config/runtime-process/host');
    const runtime = await getAgentConfigRuntimeClient();
    const result = await runtime.refreshAuthStatus({ providerId });
    return result.success ? result.data : null;
  },
};

export async function createModels(
  request: SessionpageSessionCreateModelsRequest,
  deps: CreateModelsDeps = defaultCreateModelsDeps
): Promise<CreateSessionResult<SessionpageSessionCreateModels>> {
  try {
    const agent = await findAgent(request.harness);
    if (!agent) return fail('harness_not_found', `这台机器上没有 ${request.harness}`);
    const view = await resolveSessionView(agent, request.sessionView);
    if (!view.ok) return fail('session_view_rejected', view.message);
    const { listLocalModels, probeHarnessCatalogState } = await import('@main/core/agents/session-discovery');
    const [catalog, state] = await Promise.all([
      listLocalModels(request.harness, { transport: sessionRuntimeOfView(view.view) }),
      probeHarnessCatalogState(request.harness, sessionRuntimeOfView(view.view)),
    ]);
    // 默认模型在这台机器上有没有凭据(#6264):远端创建框据此决定默认挪不挪到平台模型,与桌面同一个读数。
    const [selectedCredential, harnessAuth] = await Promise.all([
      catalog.selected ? readSelectedCredential(request.harness, catalog.selected) : Promise.resolve('unknown' as const),
      readHarnessAuth(request.harness, deps.readAuth),
    ]);
    // 推理档与桌面 composer 同一个 resolver:活目录 → 插件声明 → 按模型查静态表;平台模型再与该模型
    // 在目录里认的档取交集(#6447)。
    const requestedModel = request.model?.trim() || null;
    const platformModel = !!requestedModel && requestedModel.startsWith('platform:');
    const resolvedEfforts = resolveCreateEfforts({
      state,
      effortCapability: agent.capabilities?.effort,
      staticModelsCapability: agent.capabilities?.models,
      model: platformModel ? null : (requestedModel ?? catalog.selected),
      platformModel: platformEffortFacts(
        platformModel ? requestedModel : null,
        catalog.models.map((m) => ({ id: m.id, reasoningEfforts: m.reasoning_efforts ?? null })),
      ),
      leg: sessionpageLegOfView(view.view),
    });
    return {
      ok: true,
      value: {
        harness: catalog.harness_id,
        transport: catalog.transport,
        models: catalog.models.map((m) => ({
          id: m.id,
          name: m.name,
          ...(m.description ? { description: m.description } : {}),
          source: m.source,
          ...(m.credit_multiplier !== undefined ? { credit_multiplier: m.credit_multiplier } : {}),
          ...(m.requires_membership ? { requires_membership: true } : {}),
          ...(m.hidden ? { hidden: true } : {}),
        })),
        selected: catalog.selected,
        efforts: Object.entries(resolvedEfforts?.options ?? {}).map(([id, option]) => ({
          id,
          name: option.name,
          ...(option.description ? { description: option.description } : {}),
        })),
        selectedEffort: resolvedEfforts?.defaultId ?? null,
        harnessState: catalog.harness_catalog.state,
        harnessReason: catalog.harness_catalog.reason ?? null,
        guguReason: catalog.gugu_catalog.available ? null : (catalog.gugu_catalog.reason ?? 'unavailable'),
        selectedCredential,
        harnessAuth: harnessAuth.state,
        ...(harnessAuth.expired ? { harnessAuthExpired: true } : {}),
      },
    };
  } catch (error) {
    return failStart('create_models_failed', (error as Error)?.message ?? String(error), request.harness);
  }
}

export interface CreateSessionDeps {
  /** 这台机器上还没装所选 harness 时先装上;默认是云端 agent.create 用的**同一个** ensureAgentInstalled。 */
  ensureAgentInstalled: (provider: string) => Promise<void>;
}

// 这个模块顶层只有类型 import,真依赖在它里面也是用时再取 —— 静态 import 不会把 electron 拖进单测。
const defaultCreateSessionDeps: CreateSessionDeps = { ensureAgentInstalled };

export async function createSession(
  request: SessionpageSessionCreateRequest,
  deps: CreateSessionDeps = defaultCreateSessionDeps
): Promise<CreateSessionResult<SessionpageSessionCreateResult>> {
  const result = await createSessionSteps(request, deps);
  if (!result.ok) logCreateFailure({ provider: request.harness, code: result.error.code }, result.error.message);
  return result;
}

async function createSessionSteps(
  request: SessionpageSessionCreateRequest,
  deps: CreateSessionDeps
): Promise<CreateSessionResult<SessionpageSessionCreateResult>> {
  const prompt = request.prompt.trim();
  if (!prompt) return fail('prompt_empty', '要开一条会话,总得先有一句话');
  const titleSource = prompt;

  const resolved = await resolveProjectWorkspace({ projectId: request.projectId, projectPath: request.projectPath });
  if (!resolved.ok) return resolved;
  const { projectId } = resolved.value;
  const folder = request.cwd?.trim() ? await resolveProjectFolderWorkspace(projectId, request.cwd) : null;
  if (folder && !folder.ok) return folder;
  const workspaceId = folder ? folder.value : resolved.value.repositoryWorkspaceId;

  // ── 先把四维选择全部解析完,一维不对就在这里拒 —— 此时什么都还没建,❌ 不留空壳会话 ──
  const agent = await findAgent(request.harness);
  if (!agent) return fail('harness_not_found', `这台机器上没有 ${request.harness}`);
  const provider = agent.id as AgentProviderId;
  const view = await resolveSessionView(agent, request.sessionView);
  if (!view.ok) return fail('session_view_rejected', view.message);
  const runtime = sessionRuntimeOfView(view.view);

  if (
    request.permissionMode
    && !agentSupportsPermissionMode(agent.capabilities, request.permissionMode, runtime === 'pty' ? 'tui' : 'acp')
  ) {
    return fail('permission_mode_rejected', `${provider} 的${runtime === 'pty' ? '编程' : '通用'}展示没有「${request.permissionMode}」这一档`);
  }
  // 桌面 composer 的默认档由它的状态 hook 定(上次用过的 / 该面的默认);手机不给就按「可改文件」——
  // 与 permissionModeFromAutoApprove(false) 同一个答案:那是「改之前问我」,不是只读。
  const permissionMode: GuguPermissionMode = request.permissionMode ?? 'edit';

  /*
   * 这台机器上还没装这家:当场装上再往下走(#6264 product spec 第 6 条 —— 刚装好的咕咕 server
   * 上一个 agent 都没有,发起方看不到、也替不了那台机器点「安装」)。两种展示都要:下面建任务那一步
   * (prepareCreateSession 的引擎闸)对聊天腿和终端腿一视同仁,没装就报 harness-unavailable。
   * 放在建任务之前:装失败时库里一行都还没写,❌ 不留一条起不来的空壳会话。
   */
  if (agent.status !== 'available') {
    try {
      await deps.ensureAgentInstalled(provider);
    } catch (error) {
      // 装法那边已经翻成人话(AgentInstallFailedError);别的异常(探测失败之类)也套同一句开头,
      // 发起方看到的永远是「在那台机器上装 X 失败:原因」,❌ 不是一个裸错误码。
      const message = error instanceof AgentInstallFailedError
        ? error.message
        : describeAgentInstallFailure(provider, error instanceof Error ? error : new Error(String(error)));
      return fail('harness_install_failed', message);
    }
  }

  // 模型按 spawn **同一套**规则解释(`platform:` 前缀 = 咕咕平台模型,须在这条腿的目录里;
  // 其它 = harness 自家 id)。❌ 平台 id 不在目录里不会降级成 BYOK。
  let model: string | null = null;
  let platformModel: { modelId: string } | null | undefined;
  const requestedPlatform = request.model?.trim().startsWith('platform:') === true;
  if (request.model?.trim()) {
    try {
      // 手机是从 createModels 给的两组里**点**出来的,解释规则见 resolveCreateModelChoice。
      const { resolveCreateModelChoice } = await import('@main/core/sessions/session-orchestration');
      const choice = await resolveCreateModelChoice(provider, runtime, request.model);
      if (choice) ({ model, platformModel } = choice);
    } catch (error) {
      return failStart('model_rejected', (error as Error)?.message ?? String(error), provider, requestedPlatform);
    }
  }
  const effort = request.effort?.trim() || null;

  /*
   * ⚠️ 建会话那整条配方**用时再取**,❌ 不在模块顶层 import(理由见 agentPayloads 抬头)。
   */
  const [{ generateRandom }, createSessionOps, { sessionService }] = await Promise.all([
    import('@main/core/sessions/name-generation/generateSessionName'),
    import('@main/core/sessions/operations/createSession'),
    import('@main/core/sessions/session-service'),
  ]);
  const { prepareCreateSession, commitCreateSession, finalizeCreateSession } = createSessionOps;


  // 派任务(gugu-dev#181):第一句是一条真的咕咕消息(那张卡),要稳定 id —— 与桌面 use-create-session-callback 同。
  const taskChatId = request.taskChatId?.trim() || undefined;
  const taskMessageId = taskChatId ? randomUUID() : undefined;
  const sessionId = randomUUID();
  // 与桌面 composer 同一个翻译点。首轮内容的投递方式跟着腿走:聊天腿把第一句放进 ACP 启动队列,
  // 终端腿放进 initialPrompt(与 use-create-session-callback 对 startup-capable provider 的做法同)。
  const initialSession = {
    ...buildInitialSessionDocument({
      id: sessionId,
      provider,
      sessionView: view.view,
      prompt: request.prompt,
      permissionMode,
      model,
      effort,
      ...(platformModel !== undefined ? { platformModel } : {}),
      startupOrigin: 'session-page',
    }),
    ...(runtime === 'acp' ? { initialQueue: [{ text: prompt, origin: 'manual' as const }] } : { initialPrompt: prompt }),
    ...(taskChatId ? { taskChatId, initialMessageId: taskMessageId } : {}),
  };
  const params: CreateSessionParams = {
    projectId: projectId,
    sessionConfig: { version: '1', name: generateRandom(), initialSession },
    workspaceConfig: {
      version: '2',
      workspace: { kind: 'repository-instance', workspaceId },
    },
    // 派的任务进群坐任务座位(不发入群提示),与桌面派任务同一口径。
    ...(request.chatId ? { birthGroup: { chatId: request.chatId, asTask: Boolean(taskChatId) } } : {}),
  };

  const prepared = await prepareCreateSession(params);
  if (!prepared.success) {
    return failStart('create_task_failed', JSON.stringify(prepared.error), provider, requestedPlatform);
  }

  let convRow!: SessionRow;
  db.transaction((tx) => {
    convRow = commitCreateSession(prepared.data, tx);
  });
  finalizeCreateSession(prepared.data, convRow);

  const value: SessionpageSessionCreateResult = {
    conversationId: sessionId,
    projectId: projectId,
    title: initialSession.title ?? titleSource.slice(0, 60),
    ...(taskMessageId ? { taskMessageId } : {}),
  };

  // ── 从这里起会话行已经写下了:再失败也 ❌ 回一个错误让发起方留在新建页 —— 那会留下一条点不开的死行
  //    (#6264 走查实测:侧栏一行灰字、红点,点不动)。改为照常进这条会话:第一句话在转录里,
  //    失败原因是其后的一行、可以再试一次(spec session-always-openable)。原因码记在这台机器上,
  //    另一台桌面、另一天打开它也看得到;原文进日志。
  const launched = await launchCreatedSession({
    sessionId,
    projectId,
    runtime,
    initialQueue: runtime === 'acp' ? [{ text: prompt, origin: 'manual' as const }] : undefined,
    launchWorkspace: () => sessionService.provisionWorkspace(sessionId),
  });
  if (!launched.ok) {
    const code = classifyCreateFailure(launched.code, launched.detail, { platformModel: requestedPlatform });
    logCreateFailure({ provider, sessionId, code }, launched.detail);
    recordStartFailure(sessionId, code);
    return { ok: true, value: { ...value, startFailure: code } };
  }
  return { ok: true, value };
}

/**
 * 「再试一次」:把一条还没真正开起来的会话再起一次,第一句话照常投递。
 * 已经起过的(有 provider 会话 id)什么都不做 —— 重复点、两端同时点都无害。
 */
export async function startSession(sessionId: string): Promise<CreateSessionResult<{ started: true }>> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${sessionId}`);
  if (row.providerSessionId?.trim()) {
    clearStartFailure(sessionId);
    return { ok: true, value: { started: true } };
  }
  const [{ mapSessionRowToSession }, { sessionService }] = await Promise.all([
    import('@main/core/sessions/utils'),
    import('@main/core/sessions/session-service'),
  ]);
  const session = mapSessionRowToSession(row);
  // ACP: the creation turns are already pending rows; retrying is session-life's explicit start (its LifeView
  // carries the outcome and any failure).
  if (session.runtime === 'acp') {
    const { sessionLife } = await import('@main/core/sessions/session-life');
    sessionLife().start(sessionId, 'retry');
    clearStartFailure(sessionId);
    return { ok: true, value: { started: true } };
  }
  const runtime = 'pty';
  const platformModel = (await sessionPlatformModel(sessionId).catch(() => null)) != null;
  const launched = await launchCreatedSession({
    sessionId,
    projectId: row.projectId,
    runtime,
    initialQueue: session.initialQueue,
    launchWorkspace: async () => ({ success: true, data: await sessionService.ensureSessionMounted(row.id) }),
  });
  if (!launched.ok) {
    const code = classifyCreateFailure(launched.code, launched.detail, { platformModel });
    logCreateFailure({ provider: row.provider, sessionId, code, retry: true }, launched.detail);
    recordStartFailure(sessionId, code);
    return fail(code, launched.detail);
  }
  clearStartFailure(sessionId);
  return { ok: true, value: { started: true } };
}

/**
 * 发起方给的项目(id 或这台机器上的目录)→ 这台机器上的项目 id 与它的根工作区。
 * 远端建会话与远端建「已安排」(#6264)共用这一步:只给了目录就按远端建 agent 同一条规则找 / 登记项目,
 * 没打开过就先打开一次(与桌面上「选了文件夹就开项目」同一步)。
 */
export async function resolveProjectWorkspace(input: {
  projectId?: string | null;
  projectPath?: string | null;
}): Promise<CreateSessionResult<{ projectId: string; repositoryWorkspaceId: string }>> {
  let projectId = input.projectId?.trim() || null;
  if (!projectId) {
    try {
      const { resolveAgentSessionProject } = await import(
        '@main/core/projects/operations/resolve-agent-session-project'
      );
      projectId = (await resolveAgentSessionProject(expandHome(input.projectPath ?? ''))).id;
    } catch (error) {
      return fail('project_not_found', (error as Error)?.message ?? String(error));
    }
  }
  const { openProject } = await import('@main/core/projects/operations/openProject');
  const opened = await openProject(projectId);
  if (!opened.success) {
    return fail('project_open_failed', `打不开项目:${JSON.stringify(opened.error)}`);
  }
  const [project] = await db
    .select({ id: projects.id, repositoryWorkspaceId: projects.repositoryWorkspaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return fail('project_not_found', `这台机器上没有项目 ${projectId}`);
  // 项目根工作区就是任务要跑的地方(刚打开的项目以打开的回执为准)。取不到就如实报,
  // ❌ 不替它编一个工作区:编出来的路径会让 agent 跑在一个谁都没想到的目录里。
  const repositoryWorkspaceId = opened.data.repositoryWorkspaceId ?? project.repositoryWorkspaceId;
  if (!repositoryWorkspaceId) {
    return fail('project_not_open', '这个项目在那台机器上还没打开过,先在电脑上打开一次');
  }
  return { ok: true, value: { projectId, repositoryWorkspaceId } };
}

/**
 * 「在项目的哪个文件夹里开工」(手机新任务:点项目文件夹卡开工)→ 那个文件夹的工作区。只认这个项目的文件夹
 * (根目录或挂上的),❌ 不替它登记一个新文件夹:不是的就说出来,会话一行都不写。
 */
async function resolveProjectFolderWorkspace(projectId: string, cwd: string): Promise<CreateSessionResult<string>> {
  const target = expandHome(cwd);
  if (!isAbsolute(target)) return fail('folder_not_in_project', `文件夹要给绝对路径:${cwd}`);
  const { listProjectFolderRefs } = await import('@main/core/projects/operations/project-folders');
  const folders = await listProjectFolderRefs(projectId);
  if (!folders) return fail('project_not_found', `这台机器上没有项目 ${projectId}`);
  const folder = folders.find((candidate) => resolve(candidate.path) === resolve(target));
  if (!folder) return fail('folder_not_in_project', `${cwd} 不是这个项目的文件夹`);
  return { ok: true, value: folder.workspaceId };
}

/** `~` / `~/x` → 这台机器上的家目录(远端传来的路径按那台机器解释)。 */
function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return trimmed;
}
