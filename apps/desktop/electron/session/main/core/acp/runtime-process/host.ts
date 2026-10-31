import { join } from 'node:path';
import {
  acpApiContract,
  acpErr,
  acpRuntimeApiContract,
  resolveSessionPermissionMode,
  type AcpApiContract,
  type AcpRuntimeApiContract,
  type GuguPermissionMode,
  type AgentRunContext,
  type PromptInput,
  type SessionNoticeCode,
} from '@gugu/session-core/acp';
import {
  exposeWireToWindows,
  forwardController,
  withValidation,
  type ContractClient,
} from '@gugu/session-wire/api';
import { lazyWorker, type WorkerHandle } from '@gugu/session-wire/worker';
import { app } from 'electron';
import { getHostIpc } from '@main/lib/host-ipc';
import { appScope } from '@main/app/app-scope';
import { resolveLocalAgentRunContext } from '@main/core/agents/agent-run-context';
import { setProviderSessionId } from '@main/core/sessions/set-session-id';
import { persistCommittedTurn, storedRevertBoundary, truncateStoredHistory } from '@main/core/sessions/session-turn-store';
import { createHistoryReverter } from './history-revert';
import { resumeHistoryFacts } from './resume-history';
import { connectNativePromptPreparation } from './native-prompt-preparation';
import { applyTurnToAuthExpiry, type AuthExpiryWriter } from '@main/core/agent-config/auth-expiry-from-turns';
import { clearProviderSessionMissing, markProviderSessionMissing } from '@main/core/sessions/mark-provider-session-missing';
import { isResidentNeverRun } from '@main/core/sessions/never-run-session';
import { setSessionMcpServers } from '@main/core/sessions/set-session-mcp-servers';
import type { SessionExtensionDelivery } from '@shared/core/sessions/sessions';
import { mcpService } from '@main/core/mcp/services/McpService';
import { GUGU_MCP_SERVER_NAME } from '../../../../../mcp/gugu-mcp-name.mjs';
import { getSessions } from '@main/core/sessions/getSessions';
import {
  getEmdashMcpInjector,
  getEmdashIdentityProvisioner,
  type EmdashSessionIdentity,
  type EmdashSessionCapabilityInjection,
  type SessionPromptDelivery,
} from '@main/core/acp/emdash-mcp-injector';
import {
  getEmdashPlatformInjector,
  releaseEmdashPlatformSession,
} from '@main/core/acp/emdash-platform-injector';
import { sessionAgentDisplayName } from '@main/core/sessions/agent-display-name';
import {
  sessionPlatformModel,
} from '@main/core/sessions/platform-model-selection';
import {
  closeRuntimeForkOwnershipForRuntimeSession,
  recordRuntimeForkOwnership,
} from '@main/core/sessions/runtime-fork-ownership';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createStageLedger } from '@main/lib/stage-ledger';
import { sessionStartStageChannel } from '@shared/core/sessions/sessionEvents';
import { desktopWorkerPath } from '@main/worker-manifest';
import { stripUntrustedSessionAuthority, trustedPlatformInputPatch } from './session-meta';
import { persistAcpStartResult } from './session-persistence-policy';
import { notifySessionLive } from '@main/core/sessions/session-message-router';

export { mergeTrustedSessionMeta, stripUntrustedSessionAuthority } from './session-meta';

const ACP_WIRE_CHANNEL = 'acp-wire';

/** #4320 —— 启动比这更久就把分段耗时整份 warn 出来（沿用 #4181 的 30s 节拍）。 */
const ACP_START_BUDGET_MS = 30_000;

/**
 * 两个注入器都要的、只有这一侧读得到的两个会话事实：composer 当初选的模型来源，以及**显式**给过的名字。
 *
 * #4320 —— 它们过去在同一次 start 里被各读一遍（4 次 DB 读换 2 个事实）。合成一次不只是省往返：
 * 两个注入器读到不同的值本来就是一种可能的错，而 @@@4007 记的正是「只给其中一条填名字」酿成的那次
 * 真机事故。一次读、两处用，那种分岔在结构上就不存在了。
 */
type SessionInjectionFacts = {
  platformModel: Awaited<ReturnType<typeof sessionPlatformModel>>;
  agentDisplayName: Awaited<ReturnType<typeof sessionAgentDisplayName>>;
  /**
   * 用户在 `/mcp` 里为这条会话关掉的那几台 server(spec `mcp-session-toggle`)。
   *
   * ⚠️ 它**住在会话记录的 `config` 里**,与上面两样各有各的家 —— 这一格是 grep 出来的,
   * 不是推的:此前这个函数只读平台模型与显示名,`config` 一眼都不看,
   * 于是「写进了记录」与「注入那一层会看它」是两件互不相干的事实。
   * ⇒ 放进这里而不是在注入器里另开一次读,是这个文件抬头那条「一次读、两处用」的同一条理由。
   */
  mcpDisabledServers: readonly string[] | undefined;
  /**
   * The persisted composer effort, armed as recorded for platform and own models alike (#6447);
   * runtime views inherit it from their source.
   */
  effort: string | null | undefined;
  /**
   * 会话记录里**自己的模型**那一半(`config.model`,harness 自家 id)—— 启动时 runtime 断言的就是它(#6196)。
   *
   * 与 `sessionId` 同一条纪律:渲染进程也递一份(`acp-chat-store` 的 `conversation.model`),而那份会陈旧 ——
   * 会话中途换到平台模型后记录删了 `config.model`,陈旧的渲染端仍带着旧的自己的模型,runtime 就会把它断言回去。
   * ⇒ 以记录为准。记录里有平台决定(`platformModel` 非空)时这一半按定义为 `null` —— 两半是同一个决定。
   */
  model: string | null;
  /**
   * 这条会话**要续的那个 provider 会话 id**,取自会话记录 —— 它是这一格唯一的属主。
   *
   * ⚠️ 渲染进程也在启动入参里递一份(`acp-chat-store` 的 `_startInput`),而那一份**会陈旧**:
   * 坏掉那版里 `sessions.provider_session_id` 有多个写口,只有 `setSessionId` 会把改动广播给渲染进程,
   * 而编程腿首启那次(`hydrateSession`)是静默写。
   * 于是「本次 app 运行里新建的编程模式会话」在渲染端这一格恒为 `null`,切到通用模式时
   * 递出的就是 `null` ⇒ runtime 跳过 `session/load` 直接 `session/new` ⇒ 引擎铸一条空会话、
   * 把新 id 覆盖回记录,**该会话此前的全部上下文当场消失,而界面上一个字都不会说**
   * (#5869:mac1 实测 4/4 必现;切换前刷新一次页面就 1/1 不复现)。
   *
   * ⇒ 与 `effort` 同一条纪律(见下面 `trustedInput` 那段原注释),而且更硬:effort 读错只是跑偏一档,
   * 这一格读错**销毁整条历史**。启动入参里的 `sessionId` 一律以这份为准,❌ 不看渲染进程那份。
   */
  providerSessionId: string | null;
  /**
   * #7223 有原生会话可续、而它是建来常驻、一句没聊过的 agent ⇒ 引擎说没有这条时同一次启动里新开。
   * 只在有 id 可续时才读(首次启动本来就是新开);与上面那一格同源,❌ 不看渲染进程那份。
   */
  residentNeverRun: boolean;
  sourceSession?: {
    id: string;
    title: string;
    providerId: string;
    providerSessionEndpoint?: string;
  };
};

export async function readSessionInjectionFacts(input: {
  sessionId: string;
  sourceSessionId?: string;
}): Promise<SessionInjectionFacts> {
  // 读**持久**那条：运行时分叉的 view id 没有行。
  const identitySessionId = input.sourceSessionId ?? input.sessionId;
  const [platformModel, agentDisplayName, session] = await Promise.all([
    sessionPlatformModel(identitySessionId),
    sessionAgentDisplayName(identitySessionId),
    getSessions().then((rows) => rows.find((row) => row.id === identitySessionId)),
  ]);
  // 运行时分叉续的是来源那条的原生会话,不是自己的 ⇒ 不归这里(identity 行不是它自己的那一行)。
  const residentNeverRun =
    session?.providerSessionId && identitySessionId === input.sessionId
      ? await isResidentNeverRun(input.sessionId)
      : false;
  return {
    residentNeverRun,
    platformModel,
    agentDisplayName,
    // 这一格交给 runtime 的 `set_config_option`,原样是记录里那一档(#6447)。按模型收窄在两处:
    // 选档时(composer = harness 清单 ∩ 目录里该模型的档),与签发之后的注入边界(物化进配置文档的那一档,
    // `platformArmedEffort`)。这里拿不到签发结果;活会话不认这一档时 runtime 已有「确认当前档、转录里说一行」
    // 的路径,codex 按目录逐模型的 catalog 就近落档。#6199 曾在这里按一张全局三档表过滤 —— 那会把用户在
    // GPT/Claude 上选的 xhigh/max 悄悄改回默认。
    effort: session ? session.effort : undefined,
    model: platformModel ? null : (session?.model ?? null),
    // 缺席(运行时视图没有自己的行,或行刚被删)= 没有可续的 provider 会话 ⇒ `null`,与「新开一条」同义。
    providerSessionId: session?.providerSessionId ?? null,
    // ⚠️ 原样带上,`[]` 也带 —— `[]` = 用户决定过、一台没关;缺席 = 从没碰过。
    mcpDisabledServers: session?.mcpDisabledServers,
    sourceSession: session
      ? {
          id: session.id,
          title: session.title,
          providerId: session.providerId,
          ...(session.providerSessionEndpoint
            ? { providerSessionEndpoint: session.providerSessionEndpoint }
            : {}),
        }
      : undefined,
  };
}

export type AcpAnnounceSessionInput = {
  sessionId: string;
  notice?: { code: SessionNoticeCode; detail: string; effectiveValue?: string; previousValue?: string };
  /** #6387 扩展的「附带」,见 SessionManager.announce。 */
  turnContext?: { key: string; text: string };
  /** #7103 这一轮取票被咕咕拒的原因码 / null 撤掉,见 SessionCell.noteCredentialRefusal。 */
  credentialRefusal?: string | null;
};

export type AcpRuntimeClient = ContractClient<AcpApiContract> & {
  /**
   * 这条会话此刻attach的适配器进程(连接 key + pid)。**只在私有合同上**,渲染进程看不见进程身份;
   * 宿主转发出来是给会话重开当判据 —— 重开必须证明进程真的换了,而不是「我们调过 stop 了」。
   */
  adapterProvenance(input: {
    sessionId: string;
  }): Promise<{ connectionKey: string; pid: number | null; closing?: true } | null>;
  promptDetached(input: {
    sessionId: string;
    prompt: PromptInput;
    steerIfBusy?: boolean;
  }): Promise<{ requestId: string; queued: boolean; steered?: boolean; declined: boolean; missing?: true }>;
  waitPromptDetached(input: { requestId: string }): Promise<{ queued: boolean }>;
  /**
   * #6396 告诉一条会话一件事:转录里一行 / agent 下一轮的开头(见 SessionManager.announce)。
   * 这条会话正在起 ⇒ 等它起完再送(宿主这一侧的事实往往就是在它起的那一秒里得出的)。
   */
  announceSession(input: AcpAnnounceSessionInput): Promise<{ delivered: boolean }>;
};
type AcpRuntimeProcessClient = ContractClient<AcpRuntimeApiContract> & {
  adapterProvenance(input: {
    sessionId: string;
  }): Promise<{ connectionKey: string; pid: number | null; closing?: true } | null>;
  promptDetached(input: {
    sessionId: string;
    prompt: PromptInput;
    steerIfBusy?: boolean;
  }): Promise<{ requestId: string; queued: boolean; steered?: boolean; declined: boolean; missing?: true }>;
  waitPromptDetached(input: { requestId: string }): Promise<{ queued: boolean }>;
  /**
   * #6396 告诉一条会话一件事:转录里一行 / agent 下一轮的开头(见 SessionManager.announce)。
   * 这条会话正在起 ⇒ 等它起完再送(宿主这一侧的事实往往就是在它起的那一秒里得出的)。
   */
  announceSession(input: AcpAnnounceSessionInput): Promise<{ delivered: boolean }>;
};
type AcpRuntimeProcessHandle = WorkerHandle<AcpRuntimeApiContract>;
type AcpRuntimeHandle = Omit<AcpRuntimeProcessHandle, 'client'> & {
  readonly client: AcpRuntimeClient;
};

const acpRuntimeScope = appScope.child('acp-runtime-host');

/** 用时再 import:agent-config 那一侧的 worker ❌ 因为 ACP 起来就被提前拉起。 */
const authExpiryWriter: AuthExpiryWriter = {
  mark: async (providerId, sessionId) => (await import('@main/core/agent-config/runtime-process/host')).markAgentAuthExpired(providerId, sessionId),
  clear: async (providerId, sessionId) => (await import('@main/core/agent-config/runtime-process/host')).clearAgentAuthExpired(providerId, sessionId),
  log: (message, detail) => log.warn(message, detail),
};
const acpWorker = lazyWorker(
  () => {
    return {
      name: 'acp',
      contract: acpRuntimeApiContract,
      entry: desktopWorkerPath('acp'),
      scope: acpRuntimeScope,
      env: {
        ...process.env,
        GUGU_ACP_ATTACHMENTS_DIR: join(app.getPath('userData'), 'acp-attachments'),
        // 桥的入口不走 env:宿主按插件的 `acp.bridge` 声明解析好,随每次 start/resume 的
        // `AgentRunContext.acpAdapterEntry` 递进来(#6394;从前的 GUGU_CODEX_APP_SERVER_ACP_ENTRY 已删)。
      },
    };
  },
  {
    onSpawned: async (handle) => {
      handle.scope.add(
        await handle.client.promptSteered.subscribe(undefined, {
          onEvent: ({ sessionId }) => {
            void import('../../asks/human-tool-wait').then(({ yieldHumanToolWaits }) => yieldHumanToolWaits(sessionId))
              .catch(error => log.error('Human tool steering notification failed', { sessionId, error: String(error) }));
          },
        })
      );
      handle.scope.add(
        await handle.client.platformSessionClosed.subscribe(undefined, {
          onEvent: ({ sessionId, platformAccessSessionId }) => {
            void releaseEmdashPlatformSession(sessionId, platformAccessSessionId);
          },
        })
      );
      // #5381 会话历史落盘。运行时那份 transcript 只活在内存里,进程一走就没了,而重放能不能
      // 把它补回来取决于 provider —— 所以历史在这里落进库,界面重开时直接读库。
      // 写失败**不许**冒到运行时:那会把一次写盘失败升级成会话起不来,而丢一条历史远没有那么严重。
      handle.scope.add(
        await handle.client.turnCommitted.subscribe(undefined, {
          onEvent: (event) => {
            void persistCommittedTurn(event).catch((error) => {
              log.warn('session turn persistence failed', {
                sessionId: event.sessionId,
                source: event.source,
                error,
              });
            });
            // #6264 这一轮因鉴权被拒 ⇒ 这家在这台机器上「登录已失效」;之后正常做完一轮 ⇒ 撤掉。
            void applyTurnToAuthExpiry(event, authExpiryWriter);
          },
        })
      );
      // #881 The assistant panel's per-turn notice is prepared here, in the host, for the runtime's provider requests.
      handle.scope.add(await connectNativePromptPreparation(handle.client, log));
      handle.scope.add(
        handle.onRestarted(() => {
          // A restarted worker has no surviving adapter processes or session records.
          void releaseEmdashPlatformSession(null);
        })
      );
      // 起来之后才告诉订阅者:订阅者会再 `get()`,那要等这里返回 ⇒ 只排出去、❌ 在这里 await。
      for (const listener of spawnedListeners) queueMicrotask(() => listener(handle.process));
    },
  }
);

/**
 * 每起来一个 ACP 运行时就通知一次(开机那次、开机失败后被会话启动拉起的那次、之后任何一次重起)。
 * 订阅者据此接到**这一个**运行时上 —— 只在开机接一次的话,开机那次没起来(冷机超过就绪预算)
 * 就再也接不上,而稍后真正起来的那个运行时照常跑回合(#7199:云电脑醒来那一轮状态一直是 idle)。
 */
const spawnedListeners = new Set<(runtime: object) => void>();
/** `runtime` 只作身份用:同一个运行时(`initializeAcpRuntimeProcess()` 交回的 `process`)只接一次。 */
export function onAcpRuntimeSpawned(listener: (runtime: object) => void): () => void {
  spawnedListeners.add(listener);
  return () => {
    spawnedListeners.delete(listener);
  };
}

let rendererWireDispose: (() => void) | null = null;

export async function initializeAcpRuntimeProcess(): Promise<AcpRuntimeHandle> {
  rendererWireDispose ??= exposeRendererWire();
  return decorateAcpRuntimeHandle(await acpWorker.get());
}

export async function getAcpRuntimeClient(): Promise<AcpRuntimeClient> {
  return (await initializeAcpRuntimeProcess()).client;
}

/**
 * The ACP worker as a session-life process lease: its raw client (no start-owning wrapper) and the two facts
 * that end every session it hosts — a restart, or an exit without restart.
 */
export async function acpWorkerLease(): Promise<{
  client: AcpRuntimeProcessClient;
  onGone(listener: (cause: string) => void): () => void;
}> {
  rendererWireDispose ??= exposeRendererWire();
  const handle = await acpWorker.get();
  return {
    client: handle.client as AcpRuntimeProcessClient,
    onGone(listener) {
      const restarted = handle.onRestarted(() => listener('ACP runtime restarted'));
      const exited = handle.process.onExit(exit => { if (!exit.willRestart) listener('ACP runtime exited'); });
      return () => { restarted(); exited(); };
    },
  };
}

/**
 * ACP 运行时**如果已经起着**的 client,否则 `null` —— 不顺手把它叫起来。
 *
 * 收尾路径专用(#4467):worker 没起 ⇒ 这个界面上一条 ACP 会话都不存在 ⇒ 没有令牌、没有 0600 文档、
 * 没有续期定时器要收。这时用 `getAcpRuntimeClient()` 会**为了收尾而先起一个进程**,那是收尾自己
 * 制造出要收的东西。
 */
export async function peekAcpRuntimeClient(): Promise<AcpRuntimeClient | null> {
  const handle = await acpWorker.peek();
  return handle ? decorateAcpRuntimeHandle(handle).client : null;
}

export async function disposeAcpRuntimeProcess(): Promise<void> {
  rendererWireDispose?.();
  rendererWireDispose = null;
  // @@@2503 承载这些 Chat UI 会话的运行时整个没了 → 它们握着的平台令牌一个消费者都没有了。
  // 不结清的话,预留会一直占着额度窗口,而续期定时器还在替这些不存在的会话续命。
  // (null = 这个界面上的全部;终端会话那批不在此列,它们的进程活得好好的。)
  await releaseEmdashPlatformSession(null);
  await acpWorker.dispose();
}

function decorateAcpRuntimeHandle(handle: AcpRuntimeProcessHandle): AcpRuntimeHandle {
  return { ...handle, client: withProviderSessionIdPersistence(handle.client) };
}

// @@@sessionpage TASKPAGE-FUSION — run the gugu-registered MCP injector at the MAIN-process ACP start
// boundary (this wrapper sees input.input before it is forwarded to the worker). The injector builds the
// gugu MCP server(s) with gugu's own token/identity (things the worker can't reach) and we ride them
// on the start input to the worker's buildNewSessionRequest. Fail-loud: an injector throw (e.g. gugu MCP
// bridge unavailable for a mapped session) rejects startSession rather than silently starting a
// send-less session. No injector installed → unchanged behavior. A plugin-carried MCP surface returns no protocol
// servers, but still carries trusted session metadata and keeps the same host-selected permission mode.
// 合并说明:`effort`(本 PR,起始推理档)与 `startupOrigin`/`initialMessageId`/`initialQueue`
// (dev #4612,聊天页首轮走信封)是两侧各自的纯新增,没有语义冲突 —— 取并集,❌ 别二选一。
export async function withEmdashMcpInjection<T extends { input: { sessionId: string; sourceSessionId?: string; projectId: string; workspaceId: string; providerId: string; cwd: string; providerSessionId?: string | null; permissionMode?: GuguPermissionMode; effort?: string | null; startupOrigin?: 'chat-page' | 'session-page'; initialMessageId?: string; taskChatId?: string; initialQueue?: Array<{ text: string; hiddenContext?: string }> } }>(
  input: T,
  lifecycle: 'fresh' | 'fork' | 'resume',
  facts: SessionInjectionFacts,
  identity: EmdashSessionIdentity | null,
): Promise<{
  command: T;
  mcpServers?: EmdashSessionCapabilityInjection['mcpServers'];
  capabilitySpawnEnv?: Record<string, string>;
  capabilitySpawnArgs?: string[];
  sessionPrompt?: SessionPromptDelivery;
  sessionMeta?: Record<string, unknown>;
  platformConfigured?: boolean;
  platformModel?: string;
  platformAccessSessionId?: string;
  extensionDelivery?: SessionExtensionDelivery;
}> {
  const injector = getEmdashMcpInjector();
  // ⚠️ 档位必须在**调注入器之前**解析：会话包是在 spawn 那一刻物化的，晚一步递过去
  // 就赶不上，`units.autonomy` 会拿到 null，四家（opencode/mimocode/qwen/copilot）
  // 刚接上的自治通道就变成一条永远不被喂的死代码。
  //
  // 解析与运行时 `applyConfiguredPermissionMode`、界面、终端腿是**同一个函数**(`resolveSessionPermissionMode`),
  // ❌ 别各写一套：两条路对同一个用户选择解释出不同档 = 界面显示的和实际跑的不是一回事。
  // 解析出的档写回 input,运行时拿到的一定是显式档。
  const permissionMode = resolveSessionPermissionMode(input.input);
  if (!injector) return { command: { ...input, input: { ...input.input, permissionMode } } };
  const injection = await injector({
    sessionId: input.input.sessionId,
    sourceSessionId: input.input.sourceSessionId,
    projectId: input.input.projectId,
    workspaceId: input.input.workspaceId,
    providerId: input.input.providerId,
    cwd: input.input.cwd,
    lifecycle,
    // spec agent-provisioning:显式命名过就用那个名字开户。与 platformModel 同源同取法 ——
    // 都是创建时记在会话上、宿主自己够不着的事实,由 readSessionInjectionFacts 一次读出。
    platformModel: facts.platformModel,
    mcpDisabledServers: facts.mcpDisabledServers,
    agentDisplayName: facts.agentDisplayName,
    // ⚠️ permissionMode 不走 facts:它不是「会话上记着的事实」,而是本次启动**当场**解析出来的
    // 有效档(上面那一行)。混进 facts 会让它跟着会话被缓存,
    // 用户改了权限档却还按开会话时那一档跑。
    permissionMode,
    // 起始推理档 —— 与 permissionMode 同一条理由走这里,不进 facts。
    // 消费方按各家方言落成 spawn 参数(kimi:`KIMI_MODEL_THINKING_EFFORT`)。
    // 与下面 trustedInput 同一份:会话记录(经计费路过滤)为准,渲染进程那份只在没有记录时用。
    reasoningEffort: (facts.effort !== undefined ? facts.effort : input.input.effort) ?? null,
    startupOrigin: input.input.startupOrigin,
    initialMessageId: input.input.initialMessageId,
    taskChatId: input.input.taskChatId,
    initialMessageText: input.input.initialQueue?.[0]?.text,
    // @@@5004 行上有没有 provider session 是「首次 spawn / 重来」与「重开」的分水岭;注入器据此判
    // 「sessionId 为空却没带首句载荷」这种不一致,❌ 不再拿 lifecycle=fresh 当首次 spawn 用。
    //
    // ⚠️ 读 `facts`,❌ 不读 `input.input.sessionId`(#5869):后者是渲染进程递来的快照,会陈旧。
    // 这一格在这里**不只是记个 id**:它是「首次 spawn / 重开」的分水岭,还是 `main.ts` 那道
    // 「`sessionId === null` 却带着 initialMessageId 就抛」的 fail-loud 闸,并决定对话页那句开场白
    // 要不要再投一次 ⇒ 读错的后果是**开场白重投**或**启动被误拒**,而两者都不会指向真因。
    // 同一次 start 的两级注入必须看同一个值,❌ 不许一级读记录、另一级读渲染端。
    providerSessionId: facts.providerSessionId,
  }, identity);
  if (process.env.GUGU_DEBUG_AUTONOMY === '1') {
    log.warn('autonomy-debug: ACP start input', {
      sessionId: input.input.sessionId,
      providerId: input.input.providerId,
      lifecycle,
      requestedPermissionMode: input.input.permissionMode,
      effectivePermissionMode: permissionMode,
    });
  }
  return {
    command: {
      ...input,
      input: {
        ...input.input,
        permissionMode,
        ...(injection.initialQueue ? { initialQueue: injection.initialQueue } : {}),
      },
    },
    mcpServers: injection.mcpServers,
    capabilitySpawnEnv: injection.spawnEnv,
    capabilitySpawnArgs: injection.spawnArgs,
    sessionPrompt: injection.sessionPrompt,
    sessionMeta: injection.sessionMeta,
    platformConfigured: injection.platformConfigured,
    platformModel: injection.platformModel,
    platformAccessSessionId: injection.platformAccessSessionId,
    extensionDelivery: injection.extensionDelivery,
  };
}

// @@@2503 平台额度注入 —— 与上面的 MCP 注入并列的第二道拦截:宿主按这条会话的 composer 选择签发中转
// 令牌。Claude 产出 session/new | session/load 的 `_meta`;Codex/OpenCode 产出只走 main→worker 的
// adapter spawn 信封,renderer 合约看不到后一种形状。
//
// **start 和 resume 两条路都要过这里**。resume(重开)那条路最容易漏:适配器的 loadSession 会把
// `_meta` 转给它内部的 createSession,也就是说重开时新起的 claude 进程完全靠这份信封才知道要打哪个
// 中转。漏掉它,重开后的会话退回用户自己的 settings —— 界面还写着咕咕的模型,请求却打到用户的网关,
// 而积分早已按平台会话预留。首轮完全正常,只在重开时发作。
//
// 钩子抛错就让 startSession 抛出去:选了平台模型却签不出令牌,这条会话本来就不该开。
/** The one identity step of an ACP start; the capability injector only consumes its result. */
export function provisionStartIdentity(
  input: { sessionId: string; sourceSessionId?: string; providerId: string; projectId: string; cwd: string },
  lifecycle: 'fresh' | 'fork' | 'resume',
  facts: Pick<SessionInjectionFacts, 'agentDisplayName'>,
): Promise<EmdashSessionIdentity | null> {
  return getEmdashIdentityProvisioner()({
    sessionId: input.sessionId,
    sourceSessionId: input.sourceSessionId,
    providerId: input.providerId,
    projectId: input.projectId,
    cwd: input.cwd,
    displayName: facts.agentDisplayName,
    lifecycle,
  });
}

export async function withEmdashPlatformInjection<T extends { input: { sessionId: string; sourceSessionId?: string; forkFromProviderSessionId?: string; projectId: string; workspaceId: string; providerId: string; cwd: string; effort?: string | null; providerSessionId?: string | null } }>(
  input: T,
  lifecycle: 'fresh' | 'fork' | 'resume',
  facts: SessionInjectionFacts,
  capabilityMcpServers?: EmdashSessionCapabilityInjection['mcpServers'],
  sessionPrompt?: SessionPromptDelivery,
  capabilitySessionMeta?: Record<string, unknown>,
  capabilitySpawnEnv?: Record<string, string>,
  capabilitySpawnArgs?: string[],
  capabilityPlatformConfigured = false,
  capabilityPlatformAccessSessionId?: string,
  capabilityPlatformModel?: string,
): Promise<{ command: T; injected: boolean }> {
  // 无条件先剥掉入参里的 `sessionMeta` / `platform` / `mcpServers`。这些字段是**宿主签发**的注入信封:
  // `sessionMeta` 会被适配器摊成 claude 的 options.env 与 options.settings —— 也就是任意环境变量
  // 和任意 settings 文件路径。而 `sessionMeta` 就挂在 renderer 面向的 acpStartInputSchema 上,
  // renderer 递来的这些字段一律不能穿过；可信 MCP 结果即使是空数组也由上面的 adapter 结果重新写回。
  // BYOK/非平台会话若没有宿主信封，就保持无信封。
  // runtime-contract 里写的「renderer input can never carry a relay token」要成立,靠的就是这一步,
  // 而不是靠 renderer 自觉。
  const stripped = { ...input, input: stripUntrustedSessionAuthority(input.input) };
  const trustedInput = {
    ...stripped.input,
    // Renderer start payloads can be an older snapshot than the row created by the composer.
    // The conversation facts read above are the shared persisted source for every ACP injection
    // leg, so the provider receives the same effort that platformModelForSession materializes.
    ...(facts.effort !== undefined ? { effort: facts.effort } : {}),
    // 同一条理由(#6196):要断言的「自己的模型」只由会话记录说了算,见 `SessionInjectionFacts.model`。
    model: facts.model,
    // 同一条理由,更硬的一格(#5869):要续哪个 provider 会话**只由会话记录说了算**。
    // ❌ 不写成「渲染进程给了就用它」—— 那正是坏掉的那版:陈旧的 `null` 会让 runtime 跳过
    //    `session/load` 去 `session/new`,悄悄把这条会话的历史换成空的。缺席与陈旧在线上同形,
    //    所以这里**无条件**覆盖,而不是只在渲染进程没给的时候补。
    providerSessionId: facts.providerSessionId,
    // #7223 同一份记录、同一条纪律:无条件以宿主读到的为准(缺席就是缺席),分叉不带。
    freshIfProviderSessionMissing: !input.input.forkFromProviderSessionId && facts.residentNeverRun ? true : undefined,
    ...(input.input.sourceSessionId && input.input.forkFromProviderSessionId && facts.sourceSession
      ? { forkSourceSession: facts.sourceSession }
      : {}),
    ...(capabilityMcpServers ? { mcpServers: capabilityMcpServers } : {}),
    // ⚠️ 展开成线上的两格**只有这一处**:载荷与载体在进程内一直捆着,到边界才拆。
    //    多一处展开就多一条它们能走散的路。
    ...(sessionPrompt
      ? {
          sessionPrompt: sessionPrompt.value,
          sessionPromptCarrier: sessionPrompt.carrier,
        }
      : {}),
    ...(capabilitySessionMeta ? { sessionMeta: capabilitySessionMeta } : {}),
    ...(capabilitySpawnEnv ? { capabilitySpawnEnv } : {}),
    ...(capabilitySpawnArgs ? { capabilitySpawnArgs } : {}),
    ...(capabilityPlatformAccessSessionId ? { platformAccessSessionId: capabilityPlatformAccessSessionId } : {}),
    ...(capabilityPlatformModel ? { platformModel: capabilityPlatformModel } : {}),
  };
  const trusted = { ...stripped, input: trustedInput };
  if (capabilityPlatformConfigured) return { command: reportUnpinnedPlatformModel(trusted) as T, injected: true };
  const injector = getEmdashPlatformInjector();
  if (!injector) return { command: trusted as T, injected: false };
  const injection = await injector({
    sessionId: input.input.sessionId,
    sourceSessionId: input.input.sourceSessionId,
    projectId: input.input.projectId,
    workspaceId: input.input.workspaceId,
    providerId: input.input.providerId,
    cwd: input.input.cwd,
    lifecycle,
    // composer 当初的选择存在这一侧的 kv 里,咕咕宿主够不着(两边分开打包)—— 所以由这里读出来递过去。
    platformModel: facts.platformModel,
    // @@@4007 这一格**不是可选的**:平台注入器自己也会 provision 身份(它要先有 agent 才能签平台令牌,
    // 见 main.ts 的 `ensureAgentUserId`)。两条路都读同一份 start info,只给其中一条填名字 ⇒ 选了平台
    // 模型的会话由这条先开户、开成 `Codex N`,后面那条幂等复用,名字再也改不回来。
    // 实测(2026-08-22,真机):同一条 spec 三跑两绿一红,红的那次会话标题是「小弟」而联系人是 `Codex 2`。
    // #4320 起两条路读的是**同一次**解析结果(readSessionInjectionFacts),分岔在结构上不再可能。
    mcpDisabledServers: facts.mcpDisabledServers,
    agentDisplayName: facts.agentDisplayName,
  });
  if (!injection) return { command: trusted as T, injected: false };
  // 信封落到哪一格由 trustedPlatformInputPatch 说了算(纯函数、有测试)——
  // 「送到了错的格子」类型系统看不见,见那边的抬头。
  const command = {
    ...trusted,
    input: {
      ...trusted.input,
      ...trustedPlatformInputPatch(injection, {
        sessionMeta: capabilitySessionMeta,
        spawnEnv: capabilitySpawnEnv,
        spawnArgs: capabilitySpawnArgs,
      }),
    },
  };
  return { command: reportUnpinnedPlatformModel(command) as T, injected: true };
}

/**
 * 上了平台却说不出钉的是哪个模型 ⇒ 续接会话时 runtime 断言不了它(#6196),harness 会跑它会话记忆里的那个。
 * 这是注入侧漏报,不是这条会话的错 —— 照常开,但响亮记一行,❌ 不静默跳过断言。
 */
function reportUnpinnedPlatformModel<C extends { input: { sessionId: string; providerId: string; platformModel?: unknown } }>(command: C): C {
  if (typeof command.input.platformModel !== 'string' || !command.input.platformModel) {
    log.error('platform injection named no pinned model; a resumed provider session cannot have it re-asserted', {
      sessionId: command.input.sessionId,
      providerId: command.input.providerId,
    });
  }
  return command;
}

// 一个 worker client 只配一个包装:下面的启动属主状态属于**这个 worker**,不属于某次 `getAcpRuntimeClient()`
// 调用。每次调用各包一层 = 各有一份在途表,并入同一次启动就只在同一调用方之内成立。
// worker 重启会换 client ⇒ 状态随之清空,正对上「重启后的 worker 没有任何会话」。
const runtimeClients = new WeakMap<ContractClient<AcpRuntimeApiContract>, AcpRuntimeClient>();

function withProviderSessionIdPersistence(client: ContractClient<AcpRuntimeApiContract>): AcpRuntimeClient {
  const existing = runtimeClients.get(client);
  if (existing) return existing;
  const wrapped = createStartOwningClient(client);
  runtimeClients.set(client, wrapped);
  return wrapped;
}

async function closeAcpBrowserToolsBestEffort(sessionId: string): Promise<void> {
  const { stopHumanToolWaits } = await import('../../asks/human-tool-wait');
  stopHumanToolWaits(sessionId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  try {
    await Promise.race([
      import('../../../../../browser-agent-mcp').then(module => active ? module.closeSessionBrowserTools(sessionId) : undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Browser tool cleanup timed out after 1000ms')), 1_000);
      }),
    ]);
  } catch (error) {
    log.warn('acp stop: browser tool cleanup failed', { sessionId, error: String(error) });
  } finally { active = false; if (timer) clearTimeout(timer); }
}

/** The worker's stop has its own deadline: a stop that does not answer in 12 s is a failed stop. */
async function stopAcpWorkerSession(
  client: ContractClient<AcpRuntimeApiContract>,
  input: Parameters<ContractClient<AcpRuntimeApiContract>['stopSession']>[0],
  meta?: Parameters<ContractClient<AcpRuntimeApiContract>['stopSession']>[1],
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.stopSession(input, meta as never),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ACP worker stop timed out after 12000ms')), 12_000);
      }),
    ]);
  } catch (error) {
    log.warn('acp stop: worker teardown failed', { sessionId: input.sessionId, error: String(error) });
    return acpErr.stopFailed({ name: 'StopFailed', message: String(error) });
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * The one ACP session stop: worker stop (with its deadline) and browser tools, then — only once the worker no longer
 * owns the process — fork ownership and the platform ticket. Throws while the worker still owns the process.
 */
export async function stopAcpSessionAndSettle(client: ContractClient<AcpRuntimeApiContract>, sessionId: string): Promise<void> {
  const [result] = await Promise.all([stopAcpWorkerSession(client, { sessionId }), closeAcpBrowserToolsBestEffort(sessionId)]);
  if (!result.success && await (client as AcpRuntimeProcessClient).adapterProvenance({ sessionId }) !== null) {
    throw new Error(`ACP session ${sessionId} did not stop: ${result.error.message ?? result.error.type}`);
  }
  await closeRuntimeForkOwnershipForRuntimeSession(sessionId);
  await releaseEmdashPlatformSession(sessionId);
}

export function createStartOwningClient(client: ContractClient<AcpRuntimeApiContract>): AcpRuntimeClient {
  const detachedClient = client as AcpRuntimeProcessClient;
  type StartCall = Parameters<AcpRuntimeClient['startSession']>;
  type StartResult = Awaited<ReturnType<AcpRuntimeClient['startSession']>>;
  type PreparedStart = Awaited<ReturnType<typeof prepareStart>>;
  /** `stopped`:准备还没做完就被停了 —— 准备一完 ❌ 再交给 worker(见下面 `startOnce`)。 */
  type StartOperation = {
    prepared: Promise<PreparedStart>;
    result: Promise<StartResult>;
    stopped: boolean;
    projectId: string;
  };

  /**
   * 准备(注入)途中被停掉的那次启动:❌ 交给 worker。那时 worker 里还没有这条会话,停止递过去扑空 ——
   * 准备一完照样起,用户按了停止、会话却起来了(behavior session-page「打开速度」:会话建立途中能停)。
   * 准备里签出的平台票在这里结清:停止那一刻的结清可能早于签票。
   */
  async function settleStoppedStart(sessionId: string, projectId: string): Promise<void> {
    try {
      // 用时再 import(同 agent-hook-service 的做法):❌ 让宿主一起来就把状态写入那一整套拉进来。
      const { agentStatusWriter } = await import('@main/core/agent-status/agent-status-writer');
      await agentStatusWriter.interrupt({ sessionId, projectId });
    } catch (error) {
      log.warn('acp stop: could not settle the status of a stopped start', { sessionId, error: String(error) });
    }
  }

  async function stoppedBeforeWorker(start: PreparedStart): Promise<StartResult> {
    const sessionId = start.injected.input.sessionId;
    start.ledger.settle({ success: false });
    await releaseEmdashPlatformSession(sessionId);
    log.info('acp start: stopped before it reached the worker', { sessionId });
    return acpErr.invalidState(`Session ${sessionId} was stopped before its start reached the runtime`);
  }

  // A failed stop remains owned by its old process until actual teardown completes.
  async function finishClosingProcess(sessionId: string): Promise<void> {
    const owner = await detachedClient.adapterProvenance({ sessionId });
    if (!owner?.closing) return;
    const stopped = await stopWorker({ sessionId }, undefined as never);
    if (!stopped.success) throw new Error(`ACP process teardown did not complete: ${stopped.error.message ?? stopped.error.type}`);
    await closeRuntimeForkOwnershipForRuntimeSession(sessionId);
    await releaseEmdashPlatformSession(sessionId);
  }

  // 主进程这一段做三件互相独立的事(能力注入 / 平台注入 / 定 CLI),产出的是 worker 该拿去起会话的那份输入。
  async function prepareStart(input: StartCall[0]) {
    const lifecycle = input.input.forkFromProviderSessionId ? 'fork' : 'fresh';
    // #4320 —— ACP 启动边界的分段账本。过去这三件事合成一个不透明的 await：一次 69.6s 的 spawn 里，
    // 日志说不出是哪一件慢。预算取 #4181 报 still-running 的同一个 30s 节拍。
    const ledger = createStageLedger({
      scope: 'sessionpage/acp-start',
      what: 'acp session start',
      fields: {
        sessionId: input.input.sessionId,
        providerId: input.input.providerId,
        lifecycle,
      },
      budgetMs: ACP_START_BUDGET_MS,
    });
    const mark = (stage: string, extra?: Record<string, unknown>) => ledger.mark(stage, extra);
    // 准备这一段抛出(例如平台签发被网关 429 拒掉)时,账本里要有这一格:否则日志停在上一段,
    // 读起来像「还在跑」,而错误本身只以 `HANDLER_ERROR` 的形状到渲染层,原因丢了。
    try {
      await finishClosingProcess(input.input.sessionId);
      const facts = await readSessionInjectionFacts(input.input);
      mark('session-facts-read');
      const identity = await provisionStartIdentity(input.input, lifecycle, facts);
      mark('identity-bound');
      const capabilityInjection = await withEmdashMcpInjection(input, lifecycle, facts, identity);
      mark('capability-injected');
      const platformInjection = await withEmdashPlatformInjection(
        capabilityInjection.command,
        lifecycle,
        facts,
        capabilityInjection.mcpServers,
        capabilityInjection.sessionPrompt,
        capabilityInjection.sessionMeta,
        capabilityInjection.capabilitySpawnEnv,
        capabilityInjection.capabilitySpawnArgs,
        capabilityInjection.platformConfigured,
        capabilityInjection.platformAccessSessionId,
        capabilityInjection.platformModel,
      );
      mark('platform-injected', { injected: platformInjection.injected });
      const resolved = await withHostResolvedCli(platformInjection.command);
      mark('run-context-resolved', { resolved: resolved.input.runContext.cli.kind === 'resolved' });
      const resumeHistory = await resumeHistoryFacts(resolved.input, {});
      mark('resume-history-read', { replay: resumeHistory.replayHistory !== false });
      const injected = { ...resolved, input: { ...resolved.input, ...resumeHistory } };
      if (injected.input.sourceSessionId && injected.input.forkFromProviderSessionId) {
        log.info('acp runtime fork source injected', {
          sessionId: injected.input.sessionId,
          sourceSessionId: injected.input.sourceSessionId,
          sourceProviderSessionId: injected.input.forkFromProviderSessionId,
          sourceProviderSessionEndpoint: facts.sourceSession?.providerSessionEndpoint,
        });
      }
      return {
        injected,
        platformInjected: platformInjection.injected,
        facts,
        ledger,
        mark,
        extensionDelivery: capabilityInjection.extensionDelivery,
      };
    } catch (error) {
      mark('preparation-failed', { error: error instanceof Error ? error.message : String(error) });
      log.error('session/acp-start: preparation failed', {
        sessionId: input.input.sessionId,
        providerId: input.input.providerId,
        error,
      });
      throw error;
    }
  }

  async function finishStart(start: PreparedStart, meta: StartCall[1]): Promise<StartResult> {
    const { injected, facts, ledger, mark, extensionDelivery } = start;
    let result: StartResult;
    try {
      result = await callSessionStart(
        () => client.startSession(injected, meta),
        injected.input.sessionId,
        start.platformInjected
      );
    } catch (error) {
      log.error('session/acp-start: worker call failed', {
        sessionId: injected.input.sessionId,
        providerId: injected.input.providerId,
        error,
      });
      throw error;
    }
    mark('worker-start-returned', { success: result.success });
    await persistAcpStartResult(injected.input, result, {
      persistReturnedProviderSessionId,
      persistProviderSessionMissing,
      recordRuntimeForkOwnership,
    });
    if (result.success) {
      // 运行时此刻登记了这条会话:ACP 腿真正可投递的边界(复用路径上身份更早就绪,那一脚被拒,靠这里补上)。
      notifySessionLive(injected.input.sessionId);
      void import('../../asks/human-tool-wait').then(({ restoreHumanToolResults }) =>
        restoreHumanToolResults(injected.input.sessionId, injected.input.projectId, true))
        .catch(error => log.error('Human tool results could not resume', { sessionId: injected.input.sessionId, error: String(error) }));
      // ⚠️ ❌ **不 await** —— 它是一份 best-effort 的记录,而这里是会话启动的**响应路径**。
      //    await 它等于把「面板下次显示得准不准」挡在「用户能不能开始说话」前面:
      //    里面那次 `listForAgent` 只要慢一下,RPC 的响应就被推迟,而渲染层等的正是它,
      //    表现是**后端好好的、agent 能回话,而界面一直 Loading / 一条气泡都没有**。
      //    (它失败本来就只 warn ⇒ 更没有理由让它拖住启动。)
      void persistSessionMcpServers(
        injected.input.sessionId,
        injected.input.providerId,
        injected.input.cwd,
        facts.mcpDisabledServers,
        extensionDelivery
      );
    }
    ledger.settle({ success: result.success });
    return result;
  }

  // @@@one-start-owner (#5233) —— 一条会话的启动在主进程只有**一个**属主。
  //
  // 启动有两个入口:`startSession`,以及启动途中排队的那一句(`queuePrompt` 带 `startInput`,
  // worker 在会话还不存在时拿它直接起会话)。worker 按 conversationId 去重、**先到的那份赢**,
  // 后到的整份输入被丢掉。从前只有 `startSession` 做会话事实 / 能力 / 平台三步注入,排队那条只补 CLI ——
  // 于是编辑器一出现就发的那一句只要先到 worker,会话就以「无平台凭据、无咕咕 MCP、无系统块」起来:
  // claude 落回本机自家账号(mac1 实测 403),而界面照旧写着咕咕的模型。
  //
  // ⇒ 两个入口都加入**同一个**在途启动:注入只做一次(平台令牌只签一张),交给 worker 的是同一份输入,
  //    谁先到 worker 都无所谓。排队那一句只等「输入准备好」,不等会话起完 —— 它照旧进 runtime 的启动队列。
  // ❌ 别让排队那条再各自准备一份:那是第二次签令牌,输掉的那张在 worker 里没有主人。
  //    会话此刻在 worker 里活着时,排队那一句不再带启动输入 —— 会话在,就交给它的排队入口:那里按到达那一刻
  //    判,空闲就当场开一轮(#6762)。聊天面还没挂上会话时发的话多半就走这支,「只是排队」会让它停在空闲会话里。
  //    「活着」只问 worker(`adapterProvenance`,只对 ready 记录非空),宿主 ❌ 不另记一份:
  //    适配器异常退出时宿主收不到「停」,自记的那份就会说「在」,把启动输入剥掉,
  //    而 worker 手里只剩一条 lost 记录 —— 那句话被拒,会话也没重起(#5233 评审,单测 A 实测)。
  //    停会话先撤掉在途启动:停之后的下一次启动必须是新的一次,❌ 并入一个刚被停掉的启动
  //    (它的结果是「起来了」,它手里那张平台票已经被停会话结清)。
  const startsInFlight = new Map<string, StartOperation>();
  const stopsInFlight = new Map<string, ReturnType<typeof client.stopSession>>();
  const conditionalStops = new Set<string>();
  const closeBrowserToolsBestEffort = closeAcpBrowserToolsBestEffort;
  const stopWorker = (input: Parameters<typeof client.stopSession>[0], meta: Parameters<typeof client.stopSession>[1]) =>
    stopAcpWorkerSession(client, input, meta);
  async function waitForStop(sessionId: string): Promise<void> {
    const stopping = stopsInFlight.get(sessionId);
    if (!stopping) return;
    const result = await stopping;
    if (!result.success && (await detachedClient.adapterProvenance({ sessionId }))?.closing) {
      throw new Error(`ACP process teardown did not complete: ${result.error.message ?? result.error.type}`);
    }
  }
  const startOnce = async (input: StartCall[0], meta: StartCall[1]): Promise<StartOperation> => {
    const sessionId = input.input.sessionId;
    // Teardown owns credentials too: do not prepare a replacement while its old stop can revoke it.
    while (stopsInFlight.has(sessionId)) await waitForStop(sessionId);
    const inFlight = startsInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const prepared = prepareStart(input);
    const operation: StartOperation = {
      prepared,
      result: Promise.resolve() as never,
      stopped: false,
      projectId: input.input.projectId,
    };
    operation.result = prepared.then((start) =>
      operation.stopped ? stoppedBeforeWorker(start) : finishStart(start, meta));
    startsInFlight.set(sessionId, operation);
    const clear = (): void => {
      if (startsInFlight.get(sessionId) === operation) startsInFlight.delete(sessionId);
    };
    void operation.result.then(clear, clear);
    return operation;
  };

  const stopSession: typeof client.stopSession = (input, meta) => {
    const pending = stopsInFlight.get(input.sessionId);
    if (pending) {
      // An unconditional user stop must still run when idle reclamation declines.
      if (!input.onlyIfIdle && conditionalStops.has(input.sessionId)) {
        return pending.then(() => stopSession(input, meta));
      }
      return pending;
    }
    const inFlight = startsInFlight.get(input.sessionId);
    if (!input.onlyIfIdle && inFlight) inFlight.stopped = true;
    if (input.onlyIfIdle) conditionalStops.add(input.sessionId);
    const operation = Promise.resolve().then(async () => {
      const idleStop = input.onlyIfIdle ? await stopWorker(input, meta) : null;
      if (idleStop && !idleStop.success) {
        if (await detachedClient.adapterProvenance({ sessionId: input.sessionId }) === null) {
          await closeRuntimeForkOwnershipForRuntimeSession(input.sessionId);
          await releaseEmdashPlatformSession(input.sessionId);
        }
        return idleStop;
      }
      if (inFlight) inFlight.stopped = true;
      if (startsInFlight.get(input.sessionId) === inFlight) startsInFlight.delete(input.sessionId);
      const [result] = await Promise.all([idleStop ?? stopWorker(input, meta), closeBrowserToolsBestEffort(input.sessionId)]);
      // Lost replies do not retain credentials after the worker proves the process is gone.
      if (!result.success && await detachedClient.adapterProvenance({ sessionId: input.sessionId }) !== null) return result;
      await closeRuntimeForkOwnershipForRuntimeSession(input.sessionId);
      await releaseEmdashPlatformSession(input.sessionId);
      if (inFlight) await settleStoppedStart(input.sessionId, inFlight.projectId);
      return result;
    });
    stopsInFlight.set(input.sessionId, operation);
    const clear = (): void => {
      if (stopsInFlight.get(input.sessionId) !== operation) return;
      stopsInFlight.delete(input.sessionId);
      conditionalStops.delete(input.sessionId);
    };
    void operation.then(clear, clear);
    return operation;
  };

  return {
    ...client,
    cancelTurn: async (input, meta) => {
      const { stopHumanToolWaits } = await import('../../asks/human-tool-wait');
      stopHumanToolWaits(input.sessionId);
      // Harnesses do not all cancel their outstanding MCP requests when interrupted.
      // Stop this turn's browser work at the owning host as well; the person's page stays open.
      const { closeSessionBrowserTools } = await import('../../../../../browser-agent-mcp');
      const closingBrowser = closeSessionBrowserTools(input.sessionId);
      const [result] = await Promise.all([client.cancelTurn(input, meta), closingBrowser]);
      return result;
    },
    revertSession: createHistoryReverter({
      boundary: storedRevertBoundary,
      revert: client.revertSession,
      truncate: truncateStoredHistory,
      finish: (sessionId) => detachedClient.finishHistoryRevert({ sessionId }),
    }),
    adapterProvenance: (input) => detachedClient.adapterProvenance(input),
    promptDetached: (input) => detachedClient.promptDetached(input),
    waitPromptDetached: (input) => detachedClient.waitPromptDetached(input),
    announceSession: async (input) => {
      // #7103 取票被拒只对**进行中的那一轮**有意义(还在起的会话没有这一轮,cell 不收),而回绝取票在等它送到:
      // ❌ 等启动 —— 那会把要票的那一家一起卡住。
      if (input.credentialRefusal !== undefined) return detachedClient.announceSession(input);
      // 这条会话正在起 ⇒ 只等到它交给 worker(注入做完、startSession 已发出),❌ 不等它起完:
      // 首句在起完那一刻就发出去了,等到那时再递,agent 的首轮就还用着旧名字(#6396 实机撞到)。
      // worker 在 start 被调用的那一拍就建了记录,起到一半递进去的,随首轮进去。
      const inFlight = startsInFlight.get(input.sessionId);
      await inFlight?.prepared.catch(() => undefined);
      const delivered = await detachedClient.announceSession(input);
      if (delivered.delivered || !inFlight) return delivered;
      // 万一告知赶在 startSession 之前到了 worker:等这次启动落定再问一次,会话起来了就还能画上那一行。
      await inFlight.result.catch(() => undefined);
      return detachedClient.announceSession(input);
    },
    queuePrompt: async (input, meta) => {
      const { startInput: rendererStartInput, ...queued } = input;
      if (!rendererStartInput) return client.queuePrompt(queued, meta);
      const sessionId = rendererStartInput.sessionId;
      if (!startsInFlight.has(sessionId)) {
        const owner = await detachedClient.adapterProvenance({ sessionId });
        if (owner !== null && !owner.closing) {
          log.info('acp queue-with-start: forwarded to a live session', { sessionId, branch: 'forward-live' });
          return client.queuePrompt(queued, meta);
        }
      }
      // 哪一支由这一行说 —— 「排队首句走了哪条路」否则只能从症状倒推。
      log.info('acp queue-with-start: joins the session start', {
        sessionId,
        branch: startsInFlight.has(sessionId) ? 'join-in-flight' : 'start',
      });
      // 要续哪个 provider 会话(#5869)、跑哪一份 CLI(#5681)、带哪张平台票,都由同一次启动准备定 ——
      // ❌ 不用渲染进程递来的那份输入。准备失败(例如选了平台模型却签不出票)就原样抛给渲染层。
      const operation = await startOnce({ input: rendererStartInput }, meta);
      const { injected } = await operation.prepared;
      // 加入的那次启动在准备途中被停了:❌ 带着启动输入去 worker —— 那会把刚停掉的会话又起起来。
      if (operation.stopped) {
        return acpErr.invalidState(`Session ${sessionId} was stopped before its start reached the runtime`);
      }
      return client.queuePrompt({ ...queued, startInput: injected.input }, meta);
    },
    // #6552 会话还在起的时候用户选了模型 / 强度:worker 在启动的「设模型/强度」那一步采用它。
    // 这条会话的启动还在主进程准备(注入)的话,worker 那边还没有它 ⇒ 等到启动交给 worker 再递 ——
    // 与上面 announceSession 同一个等法;❌ 不等启动起完(那一步早过了,选择就成了第二次热切)。
    setModelOption: async (input, meta) => {
      await startsInFlight.get(input.sessionId)?.prepared.catch(() => undefined);
      return client.setModelOption(input, meta);
    },
    startSession: async (input, meta) => (await startOnce(input, meta)).result,
    stopSession,
    resumeSession: async (input, meta) => {
      while (stopsInFlight.has(input.input.sessionId)) await waitForStop(input.input.sessionId);
      await finishClosingProcess(input.input.sessionId);
      // 重开同样要带注入 —— 见 withEmdashPlatformInjection 抬头那段:漏在这里,首轮正常、重开翻车。
      const resumeFacts = await readSessionInjectionFacts(input.input);
      const identity = await provisionStartIdentity(input.input, 'resume', resumeFacts);
      const capabilityInjection = await withEmdashMcpInjection(input, 'resume', resumeFacts, identity);
      const platformInjection = await withEmdashPlatformInjection(
        capabilityInjection.command,
        'resume',
        resumeFacts,
        capabilityInjection.mcpServers,
        capabilityInjection.sessionPrompt,
        capabilityInjection.sessionMeta,
        capabilityInjection.capabilitySpawnEnv,
        capabilityInjection.capabilitySpawnArgs,
        capabilityInjection.platformConfigured,
        capabilityInjection.platformAccessSessionId,
        capabilityInjection.platformModel,
      );
      const injected = await withHostResolvedCli(platformInjection.command);
      const result = await callSessionStart(
        () => client.resumeSession(injected, meta),
        injected.input.sessionId,
        platformInjection.injected
      );
      if (result.success) {
        await persistReturnedProviderSessionId(injected.input.sessionId, result.data.providerSessionId);
        // 重开这条路**同样要写**:`/mcp` 的开关正是经重开生效的 ——
        // 只在 fresh 那条写,用户每关掉一台之后看到的都还是上一次的事实。
        // ⚠️ 同样❌不 await,理由见上面那一处。
        void persistSessionMcpServers(
          injected.input.sessionId,
          injected.input.providerId,
          injected.input.cwd,
          resumeFacts.mcpDisabledServers,
          capabilityInjection.extensionDelivery
        );
      } else if (result.error.type === 'provider_session_missing') {
        await persistProviderSessionMissing(injected.input.sessionId, injected.input.providerSessionId);
      }
      return result;
    },
  };
}

/**
 * #5681 —— 这次会话跑哪一份 CLI,由主进程定,随 start / resume 交给 worker。
 *
 * 终端腿一直读用户在 Agents 设置里选的那份;Chat UI 腿过去由 worker 自己探,而 worker 读不到那份选择,
 * 只会拿到 PATH 上赢的那一份 —— 选了 wrapper(如切账号的 `claude2`)或自定义路径的用户,两条腿跑成两个
 * 程序、两个账号。每次都现解析(❌ 不缓存):用户在设置里换了拷贝,下一次开会话就该生效。
 *
 * 解析失败不在这里抛:它作为 `unresolved` 带着解析器的诊断原文进 worker,由会话边界照常报成
 * 「起不来」—— 与从前 worker 自己找不到时用户看到的是同一条路,只是消息换成了真正的原因。
 */
export async function withHostResolvedCli<T extends { input: { providerId: string; sessionId: string; sourceSessionId?: string } }>(
  command: T
): Promise<T & { input: T['input'] & { runContext: AgentRunContext } }> {
  const sessionId = command.input.sessionId;
  // Chat UI 会话 = acp 那条腿的程序(#6335:与终端腿可以不是同一个)。
  // 这一家配对的桥接还在下载(#6394,只在用户的 CLI 升级后第一次)就等它 —— 这时 worker 还没开始起会话,
  // 启动进度里没有这一步,所以由这里经宿主的启动步骤事件报出去;命中随包 / 缓存时一条都不发。
  const runContext = await resolveLocalAgentRunContext(command.input.providerId, {
    role: 'acp',
    // Runtime-only forks have no database row; inherit the persistent source's credential binding.
    sessionId,
    sourceSessionId: command.input.sourceSessionId,
    bridgeWait: {
      onWaiting: (bridge) =>
        events.emit(sessionStartStageChannel, {
          sessionId,
          stage: 'preparing-adapter',
          executable: bridge,
          since: Date.now(),
        }),
      onSettled: () => events.emit(sessionStartStageChannel, { sessionId, stage: null }),
    },
  });
  return { ...command, input: { ...command.input, runContext } };
}

export async function callSessionStart<T extends { success: boolean }>(
  start: () => Promise<T>,
  sessionId: string,
  platformInjected: boolean
): Promise<T> {
  try {
    const result = await start();
    if (platformInjected && !result.success) {
      await releaseEmdashPlatformSession(sessionId);
    }
    return result;
  } catch (error) {
    if (platformInjected) await releaseEmdashPlatformSession(sessionId);
    throw error;
  }
}
/**
 * 把「这条会话起进程那一刻被带上哪几台 MCP server」写进会话记录(spec `mcp-session-toggle`)。
 *
 * ⚠️ 这是**事实**那一半。面板另有**意图**那一半(`用户当下的配置 ∖ 关闭集合`),
 * 两者会分岔,而分岔的方向都是界面撒谎 —— 见 `set-session-mcp-servers.ts` 抬头。
 *
 * ⚠️ 快照在**会话起来之后**取,而不是在 spawn 之前:这一条本身就是个近似
 * (咕咕读的是用户配置文件,不是 harness 报回来的装载结果),但**分岔窗口是亚秒级**,
 * 而它要防的那两种撒谎是**分钟到小时级**的。⇒ 这一格如实写在字段名与注释里,
 * ❌ 不把它叫成「已装载」——那是一句我们没有证据的话。
 *
 * 失败只 warn:它跑在启动成功之后,抛出去会把一次成功的启动变成失败,而写丢了只是
 * 面板这一次退回用意图算,下次重开自愈。代价不对称。
 */
export async function persistSessionMcpServers(
  sessionId: string,
  providerId: string,
  cwd: string,
  disabled: readonly string[] | undefined,
  extensionDelivery: SessionExtensionDelivery | undefined
): Promise<void> {
  try {
    // 按这条会话的目录读:分目录的那几层(Claude 的本地级 / 项目级)也是它起进程时带上的。
    const configured = await mcpService.listForAgent(providerId, cwd);
    const off = new Set(disabled ?? []);
    const names = configured
      .map((server) => server.name)
      // 咕咕自己那台不进面板,也不进这份事实 —— 面板与事实的可见域必须一致,
      // 否则用户会在"这条会话里有哪几台"里看到一台他从没装过、也关不掉的东西。
      .filter((name) => name !== GUGU_MCP_SERVER_NAME && !off.has(name));
    await setSessionMcpServers(sessionId, names, extensionDelivery);
  } catch (error) {
    log.warn('ACP runtime failed to record the session MCP server snapshot', {
      sessionId,
      error: String(error),
    });
  }
}

export async function persistReturnedProviderSessionId(sessionId: string, providerSessionId: string): Promise<void> {
  const result = await setProviderSessionId(sessionId, providerSessionId);
  if (!result.success) {
    log.warn('ACP runtime failed to persist returned session id', {
      sessionId,
      error: result.error,
    });
    return;
  }
  // 起来了 ⇒「引擎那边没有这条」不再成立(#7223:没聊过的常驻 agent 被同一个引擎新开了)。
  if (await clearProviderSessionMissing(sessionId, providerSessionId)) {
    log.info('ACP runtime cleared a stale missing mark after the session started', { sessionId });
  }
}

export async function persistProviderSessionMissing(
  sessionId: string,
  providerSessionId: string
): Promise<void> {
  const marked = await markProviderSessionMissing(sessionId, providerSessionId);
  if (!marked) {
    log.warn('ACP runtime did not mark a stale provider session as missing', {
      sessionId,
      providerSessionId,
    });
  }
}

/**
 * 渲染层的 `acp-wire:connect` 在开机那一刻就挂上,不等运行时起来:每次 connect 都先 `get()`。
 * 运行时第一次没起来 ⇒ 这次 connect 带着原始错误失败;界面上的 Try again 再 connect 一次,就是重新起它的那一次。
 */
function exposeRendererWire(): () => void {
  const hostIpc = getHostIpc();
  return exposeWireToWindows(
    {
      ipcMain: hostIpc.ipcMain,
      createMessageChannel: (event) => hostIpc.createMessageChannel(event),
    },
    () => acpWorker.get(),
    (handle) =>
      withValidation(acpApiContract, forwardController(acpApiContract, withProviderSessionIdPersistence(handle.client)), runtimeWireValidationPolicy()),
    { channel: ACP_WIRE_CHANNEL }
  );
}

function runtimeWireValidationPolicy() {
  return import.meta.env.DEV ? 'full' : 'inputs';
}
