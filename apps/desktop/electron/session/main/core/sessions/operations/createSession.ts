import { enqueueCreationTurns } from '../session-life-creation';
import { mcpLibraryService } from '@main/core/mcp-library/service';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { err, ok, type Result } from '@gugu/session-shared';
import {
  composerPlatformModel,
  recordSessionPlatformModel,
} from '@main/core/sessions/platform-model-selection';
import { buildSessionRow } from '@main/core/sessions/build-session-row';
import { sessionBorn } from '@main/core/sessions/session-born';
import { rememberBirthGroup } from '@main/core/sessions/birth-groups';
import {
  checkLocalHarnessAvailable,
  type HarnessUnavailable,
} from '@main/core/sessions/impl/harness-availability';
import { resolveProjectFolder } from '@main/core/projects/operations/project-folders';
import { projectManager } from '@main/core/projects/project-manager';
import { db, type DrizzleTx } from '@main/db/client';
import { sessions } from '@main/db/schema';
import type { SessionRow } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionCreatedChannel } from '@shared/core/sessions/sessionEvents';
import type {
  CreateSessionError,
  CreateSessionParams,
  CreateSessionSuccess,
} from '@shared/core/sessions/create-session';

type ConvInsert = typeof sessions.$inferInsert;

/**
 * @@@5173 建会话之前先确认引擎此刻起得来。
 *
 * 只对**本机**会话提问:判据用本机执行上下文,拿它去回答一个远端项目的问题会得到另一台机器的答案
 * (本机没装 = 挡掉一个在远端完全正常的会话)。远端项目维持既有行为。
 */
async function preflightHarness(
  ic: InitialSession
): Promise<HarnessUnavailable | null> {

  // 只管**新建**。导入是另一个动词:历史本来就在引擎那边,咕咕只是把它认领进来,这一刻不启动任何
  // 会话 —— 拿引擎此刻起不起得来去挡它,会让「引擎装在别处 / 暂时不可用」变成导入不了历史,
  // 而那是一条谁都没要求过的新限制。spec(session-resume)也把 fork 与导入排除在「新建」之外。
  if (ic.origin?.kind === 'import') return null;

  // 与下面建会话同一个缺省(`runtime: ic.type ?? 'pty'`):问的是真会起的那条腿的程序(#6335)。
  return checkLocalHarnessAvailable(ic.provider, ic.type === 'acp' ? 'acp' : 'tui');
}

type InitialSession = NonNullable<CreateSessionParams['sessionConfig']['initialSession']>;

export interface PreparedCreateSession {
  params: CreateSessionParams;
  workspaceId: string;
  convInsert: ConvInsert;
}

/**
 * Performs all async preparation for creating a session (project validation, workspace
 * resolution). Returns a `PreparedCreateSession` that can be committed synchronously
 * inside a Drizzle transaction via `commitCreateSession`.
 */
export async function prepareCreateSession(
  params: CreateSessionParams
): Promise<Result<PreparedCreateSession, CreateSessionError>> {
  if (!projectManager.getProject(params.projectId)) {
    return err({ type: 'project-not-found' });
  }
  const ic = params.sessionConfig.initialSession;
  // 建会话就是建它的首轮会话:没有它就没有可建的东西。这是调用方的错,不是用户能遇到的状态。
  if (!ic) throw new Error('createSession: a session is created together with its initial agent config');

  // @@@5173 引擎不可用时不要建出一条起不来的会话。
  // 这里是**唯一**的创建动词(见 sessions/controller.ts),而下面所有落库都在 commitCreateSession
  // 的事务里 —— 在这一步返回失败,库里一行都不会写,用户也就没有需要手动删的残骸。
  // 判据现场重跑,❌ 不读依赖探针那份启动时快照:快照回答的是「早些时候装没装」,而本 bug 正是
  // 运行中被换掉 —— 快照说可用,闸就放行了。
  const unavailable = await preflightHarness(ic);
  if (unavailable) {
    return err({
      type: 'harness-unavailable',
      reason: unavailable.reason,
      providerId: unavailable.providerId,
      harnessName: unavailable.harnessName,
      detail: unavailable.detail,
    });
  }

  const { workspaceId } = params.workspaceConfig.workspace;
  // #7341 会话只在这个项目自己的文件夹里开工:根目录,或挂在它下面的文件夹(会话就在那个文件夹的路径里跑,
  // 见 workspace-bootstrap-service)。从前这里照抄 id 不核对:抄进一个别的项目的工作区,会话就跑去那里。
  // ❌ 也不悄悄换成根目录 —— 用户点的是哪个文件夹,就得在哪个文件夹;不在这个项目里就说出来。
  const folder = await resolveProjectFolder(params.projectId, workspaceId);
  if (!folder) {
    return err({
      type: 'provision-failed',
      message: `工作区 ${workspaceId} 不是项目 ${params.projectId} 的文件夹:既不是它的根目录,也没有挂在它下面`,
    });
  }

  // @@@2503 composer 平台模型 — 首轮会话由 composer 拍板,选择记在会话上。写在事务之外、启动之前:
  // 会话是在 provisioning 之后才 spawn 的,这里落库足够早。
  // 载荷里没有这个字段(自动化建的会话)= 没有 composer 决策 → 什么都不记,沿用 agent 级默认。
  const platformModel = composerPlatformModel(ic);
  if (platformModel !== undefined) {
    await recordSessionPlatformModel(ic.id, platformModel);
  }
  // 会话行只有一处构造(buildSessionRow):这里曾经抄着另一份,于是 config、出生状态、
  // session_id 三处各自漂移。闸也在那里 —— 新建不带首轮当场抛。
  const convInsert = buildSessionRow({
    id: ic.id,
    projectId: params.projectId,
    workspaceId,
    ...(params.sessionConfig.linkedIssue && { linkedIssue: params.sessionConfig.linkedIssue }),
    ...(params.automationRunId && { automationRunId: params.automationRunId }),
    title: ic.title ?? '',
    ...(ic.titleSource && { titleSource: ic.titleSource }),
    provider: ic.provider as AgentProviderId,
    runtime: ic.type ?? 'pty',
    origin: ic.origin,
    permissionMode: ic.permissionMode,
    model: ic.model,
    effort: ic.effort,
    // 资源库 → MCP:每条新任务都带「默认启用」的那几台 —— 资源库的开关是唯一的控制点。
    libraryMcp: (await mcpLibraryService.list()).filter((server) => server.enabledByDefault).map((server) => server.name),
    initialPrompt: ic.initialPrompt,
    initialQueue: ic.initialQueue,
    startupOrigin: ic.startupOrigin,
    initialMessageId: ic.initialMessageId,
    taskChatId: ic.taskChatId,
    // 首启由 hydrateSession 做(工作区要先 provision 完),所以这一行落库时**不**认领
    // session_id —— 那把尺子留给 hydrate 用。
    claimsFirstSpawn: false,
  });

  return ok({ params, workspaceId, convInsert });
}

/**
 * Synchronously runs the session insert within the provided transaction.
 * Must be called with a `PreparedCreateSession` from `prepareCreateSession`. Returns the raw row;
 * call `finalizeCreateSession` after the transaction commits to build the result and emit
 * side-effect events.
 */
export function commitCreateSession(prepared: PreparedCreateSession, tx: DrizzleTx): SessionRow {
  const [convRow] = tx.insert(sessions).values(prepared.convInsert).returning().all();
  return convRow;
}

/**
 * Builds the `CreateSessionSuccess` result and emits post-commit side-effect events.
 * Call this after the transaction that ran `commitCreateSession` has committed.
 */
export function finalizeCreateSession(
  prepared: PreparedCreateSession,
  convRow: SessionRow
): CreateSessionSuccess {
  // Born in a group: its identity joins it when first minted (birth-groups.ts), the same as a spawned child.
  if (prepared.params.birthGroup) rememberBirthGroup(convRow.id, prepared.params.birthGroup);
  // 出生排在这条会话的任何事件之前。新建带首轮 ⇒ 出生即 working,
  // ❌ 不再补发一条首句的 start:running 时 start 翻成空,它对读数从来不起作用。
  const session = sessionBorn(convRow, 'createSession');
  events.emit(sessionCreatedChannel, { session });
  return { session };
}

export async function createSession(
  params: CreateSessionParams
): Promise<Result<CreateSessionSuccess, CreateSessionError>> {
  const prepared = await prepareCreateSession(params);
  if (!prepared.success) return prepared;

  let convRow!: SessionRow;
  db.transaction((tx) => {
    convRow = commitCreateSession(prepared.data, tx);
  });

  const created = finalizeCreateSession(prepared.data, convRow);
  // The desktop entry (a task page creating its own session): its first message is the session's first pending row,
  // which starts it. The other entries admit theirs where they launch (launchCreatedSession, agent.create, spawn).
  if (created.session.runtime === 'acp') enqueueCreationTurns(created.session);
  return ok(created);
}
