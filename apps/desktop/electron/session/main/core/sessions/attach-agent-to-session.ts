import { randomUUID } from 'node:crypto';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { GuguPermissionMode } from '@gugu/session-core/acp';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { SessionTitleSource } from '@shared/core/sessions/session-config';
import { sessionCreatedChannel } from '@shared/core/sessions/sessionEvents';
import { sessionBorn } from './session-born';
import {
  type Session,
  type SessionOrigin,
  type SessionRuntime,
  type InitialQueuePrompt,
} from '@shared/core/sessions/sessions';
import { getPlugin } from '../agents/plugin-registry';
import { buildSessionRow } from './build-session-row';
import {
  composerPlatformModel,
  sessionPlatformModel,
  recordSessionPlatformModel,
} from './platform-model-selection';
import { mountSpawnedSession } from './spawn-session';
import { resolveSession } from '../projects/utils';

type SessionCreateDb = Pick<typeof db, 'delete' | 'insert' | 'select'>;

/**
 * Where a conversation came from, when it did not come from a person.
 *
 * `spawnedByConversationId` used to be required, which encoded「发起者必是另一条
 * 会话」into the type — true until extensions could start one. An extension is
 * not a conversation, and borrowing some other session's id to satisfy the type
 * would have written a false originator into the session graph, which is the
 * one thing this record exists to prevent. Both are optional now; whichever is
 * set is the truth, and neither being set means a person did it.
 */
export type InternalSessionRelations = {
  /** 父会话:本机的进这一格,别的机器上的进 `parentRemote` —— 两格一起由 `storedParent` 给出。 */
  parentSessionId: string | null;
  parentRemote?: { deviceId: string; sessionId: string };
  spawnedBySessionId?: string;
  /** The extension that started it. Kept as plain text so the mark survives its uninstall. */
  spawnedByExtensionId?: string;
  /**
   * A session on another machine started it. The two columns above are foreign keys into this
   * machine's database and cannot hold it, so it lives in config (session trees are per machine).
   */
  spawnedByRemote?: { deviceId: string; sessionId: string; agentUserId?: string; name?: string };
};

/**
 * 在**已有的工作区**里再起一条会话(fork / 派活 / 侧边会话都是「往同一份工作副本里再放一个 agent」)。
 *
 * ❌ 它**不在** RPC 面上(见 controller.ts):对外只有一个创建动词 `sessionCreate.createSession`。
 * 它一旦开成入口,用户就能从缝里造出没有首轮的空会话 —— 那正是 spec session-resume 要消灭的东西。
 * 详见 [[agent-creation]] 与 [[session-resume]]。
 */
export type AttachAgentToSessionParams = {
  id?: string;
  projectId: string;
  /** 来源会话的工作区:新会话和它共用同一份工作副本。 */
  workspaceId: string;
  provider: AgentProviderId;
  title: string;
  /** 这条会话是怎么来的 —— 新建(必带首轮)/ 分叉。口径见 SessionOrigin。 */
  origin: SessionOrigin;
  permissionMode?: GuguPermissionMode;
  model?: string;
  effort?: string;
  /**
   * composer 里选中的「咕咕提供的模型」。三态,口径见 SessionPlatformModel:
   * 缺席 = 这条路径没有 composer(分叉 / 派活 / 导入),回落 agent 级;null = 明确选了 harness;
   * 对象 = 平台模型。
   */
  platformModel?: { modelId: string } | null;
  /**
   * 这条会话是照着**哪条会话**建出来的。派生路径(fork / session_spawn / 扩展派活)都是零 composer
   * 输入的复制动作:载荷里没有平台决策,而源会话的那条记录必须跟过来,否则一条跑在平台模型上的会话
   * 复制出来的会话会落进「从没决策过」、回退 agent 级 —— 多半就是 BYOK,而界面上它自称继承了模型(#4366)。
   * fork 从 `origin` 自报源会话,不必再传这个字段。
   */
  inheritPlatformModelFrom?: string;
  /**
   * spec session-graph:派活的一方**显式**给这条会话起的名字。它同时是这个 agent 在咕咕
   * 通讯录里的显示名(spec agent-provisioning)。缺席 = 没人显式命名过。
   */
  agentDisplayName?: string;
  /** 标题的来历;显式命名(派活给了 title、agent 自己的名字)带 `manual`,首轮兜底不带。 */
  titleSource?: SessionTitleSource;
  initialSize?: { cols: number; rows: number };
  /** System bootstrap compatibility only. Ordinary user text uses sendMessage. */
  initialPrompt?: string;
  /** System bootstrap compatibility only. Ordinary user text uses sendMessage. */
  initialQueue?: InitialQueuePrompt[];
  startupOrigin?: 'chat-page' | 'session-page';
  initialMessageId?: string;
  /** Session-graph spawn uses this to persist (and mount) the child before starting its provider asynchronously. */
  deferStart?: boolean;
  runtime?: SessionRuntime;
  /** spec session-fork-share: provider-native session id to fork from (pty only). */
  forkFromProviderSessionId?: string;
};

export async function attachAgentToSession(
  params: AttachAgentToSessionParams,
  database: SessionCreateDb = db,
  relations?: InternalSessionRelations
): Promise<Session> {
  const id = params.id ?? randomUUID();
  const sessionRuntime = params.runtime ?? 'pty';

  // spec session-fork-share:「任意会话可 fork」。两种 runtime 各有自己的分叉动作 ——
  // pty 走 `--resume <src> --fork-session --session-id <new>`(spawn 时当场用掉),
  // ACP 走 `session/fork`(懒启动,所以来源 id 要落进 config,见 buildSessionRow)。
  // 闸只管「这是不是一次真分叉」:没有来源会话 id、或这一家根本不支持分叉,就当场响亮地拒,
  // ❌ 不许静默开一条冒充分叉的新会话。
  if (params.origin.kind === 'fork') {
    if (!params.forkFromProviderSessionId) {
      throw new Error('fork needs the source provider session id');
    }
    if (getPlugin(params.provider).capabilities.sessions.fork !== 'supported') {
      throw new Error(`provider ${params.provider} does not support forking sessions`);
    }
  }

  // @@@2503 composer 平台模型 — 记在会话行**之前**落库:spawn 一发生,宿主的 pty 钩子就要按这条记录
  // 决定这次会话上不上平台中转,晚一步写等于第一次启动读不到选择。写失败就整单失败(此时还没有会话行,
  // 不会在界面上留下一个起不来的会话)。
  //
  // 派生是零输入操作:fork、session_spawn、扩展派活都照抄源会话(模型、权限档都是抄的),
  // 载荷里根本没有 composer 字段。所以这里替它们把源会话的平台决策继承过来 —— 否则一个跑在平台
  // 额度上的会话派生出来会落进「从没决策过」,于是回退 agent 级、多半就是 BYOK,而 UI 上它自称
  // 继承了模型(#4366 的军训 case 就是这个形状)。源会话自己也没记录(存量会话)时继续什么都不记,
  // 回退语义原样传下去。
  // 三条派生路都走这一处,不是各自在调用点抄一份:抄第二份的那天,两处就开始分岔。
  // ❌ 不能写成 `composerPlatformModel(params) ?? 继承`:`??` 把「明确选了 harness」的 null 也当成
  // 空值,于是一个显式的 BYOK 选择会被源会话的平台记录顶掉。这里要分的正是 null 与 undefined。
  const composerChoice = composerPlatformModel(params);
  const derivedFromId =
    params.origin.kind === 'fork'
      ? params.origin.forkedFrom.sessionId
      : params.inheritPlatformModelFrom;
  const platformModel =
    composerChoice !== undefined
      ? composerChoice
      : derivedFromId
        ? await sessionPlatformModel(derivedFromId)
        : undefined;
  if (platformModel !== undefined) {
    await recordSessionPlatformModel(id, platformModel);
  }

  const [row] = await database
    .insert(sessions)
    .values(
      buildSessionRow({
        id,
        projectId: params.projectId,
        workspaceId: params.workspaceId,
        title: params.title,
        provider: params.provider,
        runtime: sessionRuntime,
        origin: params.origin,
        permissionMode: params.permissionMode,
        model: params.model,
        effort: params.effort,
        initialPrompt: params.initialPrompt,
        initialQueue: params.initialQueue,
        startupOrigin: params.startupOrigin,
        initialMessageId: params.initialMessageId,
        agentDisplayName: params.agentDisplayName,
        titleSource: params.titleSource,
        forkFromProviderSessionId: params.forkFromProviderSessionId,
        parentSessionId: relations?.parentSessionId ?? null,
        ...(relations?.parentRemote ? { parentRemote: relations.parentRemote } : {}),
        spawnedBySessionId: relations?.spawnedBySessionId ?? null,
        spawnedByExtensionId: relations?.spawnedByExtensionId ?? null,
        ...(relations?.spawnedByRemote ? { spawnedByRemote: relations.spawnedByRemote } : {}),
        // 这条路自己就地 spawn(下面),所以落库即认领首次启动。
        claimsFirstSpawn: true,
      })
    )
    .returning();

  // 这条会话的运行时挂在它自己的 id 上:落行之后才挂得了。挂载失败 = 撤掉这一行再抛,❌ 留一条起不来的孤儿行。
  await mountSpawnedSession(params.projectId, id);

  // 出生在会话能开口(spawn)之前:之后的 hook 都排在它后面。
  const session = sessionBorn(row, 'attachAgentToSession');

  // ACP conversations start lazily on hydrateSession — no PTY session here.
  if (sessionRuntime !== 'acp' && !params.deferStart) {
    /**
     * ⚠️ 首次启动失败时，这里**曾经**把刚落库的那一行整条删掉（withCompensation 的 compensate）。
     * 后果不是「回滚得干净」，而是**用户刚打的那句话连同这条会话一起凭空消失**：
     * 第一句话就存在这一行里（`initialPrompt` / `firstUtterance`），侧栏里什么都不剩、
     * 也没有任何提示（spec `session-always-openable`：「打不开」不是一种可接受的降级形态，
     * 而「连东西都没了」比打不开更坏）。
     *
     * 引擎起不来是**可以重来**的：PTY 腿有 `sessionStartupFailures` 账本 + 重试出口，
     * ACP 腿本来就是懒启动。所以这一行留着 —— 会话照常出现在列表里，带着那句话和一个重试。
     * 要不要删掉它是用户的决定，❌ 不由一次失败替他做。
     *
     * 失败仍然如实上抛（调用方据此写失败账本、界面据此给出重试），只是不再销毁证据。
     */
    const mounted = resolveSession(params.projectId, id);
    if (!mounted) throw new Error(`Session ${id} is not mounted`);
    try {
      await mounted.sessions.startSession(
        session,
        params.initialSize,
        false,
        params.initialPrompt,
        params.forkFromProviderSessionId
      );
    } catch (error) {
      log.error('attachAgentToSession: first spawn failed; keeping the session row for retry', {
        sessionId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      events.emit(sessionCreatedChannel, { session });
      throw error;
    }
  }

  events.emit(sessionCreatedChannel, { session });

  return session;
}
