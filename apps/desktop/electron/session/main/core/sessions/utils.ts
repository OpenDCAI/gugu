import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { type SessionRow } from '@main/db/schema';
import { readInterruptedTurn } from '@main/core/agent-status/interrupted-turns';
import { parseAgentStatus, parseAgentStatusDetail } from '@gugu/core/shared/agentStatus';
import { isDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import {
  type Session,
  type SessionRuntime,
  type InitialQueuePrompt,
  type InterruptedBy,
} from '@shared/core/sessions/sessions';

// #6823 Stored startup text without an origin (payloads from before #6823 — 2026-09-30: 246 rows on the Windows Beta
// profile, 173 on mac1, and 「重来」 delivers them again — plus 「重来」's replay) is read with core's one envelope reader.
const storedOrigin = (text: string): InitialQueuePrompt['origin'] => (isDeliveryEnvelope(text) ? 'communication' : 'manual');

function initialQueueFromRow(row: SessionRow): InitialQueuePrompt[] | undefined {
  if (row.providerSessionId !== null) return undefined;
  const config = row.config;
  if (config?.type !== 'acp') return undefined;
  if (config.initialQueue?.length) {
    return config.initialQueue.map((prompt) => ({ ...prompt, origin: prompt.origin ?? storedOrigin(prompt.text) }));
  }
  const legacyPrompt = config.initialPrompt?.trim();
  return legacyPrompt ? [{ text: legacyPrompt, origin: storedOrigin(legacyPrompt) }] : undefined;
}

/**
 * 这条会话的父会话。本机的在 `parent_session_id`;别的机器上的记在 config `parentRemote`(本机外键装不下)。
 * 侧栏、手机、session_get 都读这一处。`spawnedByRemote.nested` 是 2026-10-01 起到它被 `parentRemote` 取代之间
 * 写下的同一个事实(父会话 = 派它的那条),那些行照样读得出来。
 */
export function sessionParentId(row: Pick<SessionRow, 'parentSessionId' | 'config'>): string | null {
  const legacy = row.config?.spawnedByRemote;
  return row.parentSessionId ?? row.config?.parentRemote?.sessionId ?? (legacy?.nested ? legacy.sessionId : null);
}

/** 父会话在哪:本机的一条(按 id),别的机器上的一条,或没有(根会话)。 */
export type SessionParent = { localSessionId: string } | { deviceId: string; sessionId: string } | null;

/**
 * 父会话在行里的存法 —— 建行(spawn 的 nest)与改(session_set_parent)都经这一处:本机的进外键,
 * 别的机器上的进 config `parentRemote`,两格只有一格有值。
 */
export function storedParent(parent: SessionParent): {
  parentSessionId: string | null;
  parentRemote: { deviceId: string; sessionId: string } | undefined;
} {
  if (parent === null) return { parentSessionId: null, parentRemote: undefined };
  if ('localSessionId' in parent) return { parentSessionId: parent.localSessionId, parentRemote: undefined };
  return { parentSessionId: null, parentRemote: { deviceId: parent.deviceId, sessionId: parent.sessionId } };
}

/**
 * 停 / 归档自己:回执还没到,调用方的进程先没了 —— session_stop 和 agent 操作的 App 页面(owner 10-14)同一道检查。
 * 改自己挂在谁下面没有这个问题。
 */
export function refuseItself(verb: string, targetId: string, callerSessionId: string | null | undefined): void {
  if (targetId === callerSessionId) throw new Error(`a session cannot ${verb} itself — a person does that from the session page`);
}

/**
 * 派它的会话。本机的在 `spawned_by_session_id`;别的机器上的会话派来的记在 config。「连同子会话」按它与
 * 父会话两条边数后代,所以别的机器上的 child 也数得到。
 */
export function sessionSpawnerId(row: Pick<SessionRow, 'spawnedBySessionId' | 'config'>): string | null {
  return row.spawnedBySessionId ?? row.config?.spawnedByRemote?.sessionId ?? null;
}

/** 出错的会话:是不是开机收残记下的「上一轮被宿主的退出打断」。读不出不挡列表。 */
function interruptedBy(sessionId: string): { interruptedBy?: InterruptedBy } {
  try {
    const by = readInterruptedTurn(sessionId);
    return by ? { interruptedBy: by } : {};
  } catch {
    return {};
  }
}

export function mapSessionRowToSession(
  row: SessionRow,
  resume: boolean = false
): Session {
  const config = row.config;
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    projectId: row.projectId,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    ...(row.linkedIssue ? { linkedIssue: row.linkedIssue } : {}),
    ...(row.automationRunId ? { automationRunId: row.automationRunId } : {}),
    providerId: row.provider as AgentProviderId,
    // @@@5597-permission-mode-survives-the-row — 落库的四档必须**读回来**。
    //
    // 这一格此前**整个缺席**:写入端(build-session-row)老老实实把 `permissionMode` 写进
    // config,而这里 —— 行 → Conversation 的**唯一**映射器 —— 只摊了旁边那个旧布尔。
    // 于是每一个从行上读档的消费者拿到的都是 `undefined`,而 `undefined` 会被下游当作
    // 「这条会话没有显式选过档」,回落到只认布尔的老路:
    //  · 终端腿 `local-session.ts` 的 argv 因此一个权限 flag 都不推 ⇒ claude 落 `default`
    //    (只读),用户选的规划/编辑一个字节都没到达进程(#5597 的第三处病根,实测:选 plan
    //    的 claude Code 腿 argv 上既没有 `--permission-mode plan` 也没有别的档位 flag);
    //  · ACP 腿只在**新建那一刻**侥幸正确 —— renderer 的乐观 Conversation 自带这个字段;
    //    一旦重开/重载走回这个映射器,档就没了。
    // ⚠️ 布尔在旁边活着,正是它让这个缺席**不报错**:两个字段一个在一个不在,读起来像
    //    「这条会话本来就只有布尔」。⇒ 写入端写了什么,读取端就必须读回什么。
    permissionMode: config?.permissionMode,
    providerSessionId: row.providerSessionId ?? undefined,
    providerSessionState: config?.providerSessionState,
    pendingRestart: config?.pendingRestart,
    model: config?.model,
    effort: config?.effort,
    // MCP 会话级开关**只在 ACP 那一支上有**:pty 会话不经 ACP 拿 MCP,
    // 所以那两个键没有加到 pty 配置里 —— 这里按 `type` 收窄,而不是给 pty 也补两个恒空的字段。
    // ⚠️ 原样摊出来,❌ 不在这里把 `[]` 归一成 undefined:
    //    `[]` = 用户决定过一台没关(会话仍要独占适配器),缺席 = 从没碰过。
    mcpDisabledServers: config?.type === 'acp' ? config.mcpDisabledServers : undefined,
    mcpToggleDecided: config?.type === 'acp' ? config.mcpToggleDecided : undefined,
    mcpSessionServers: config?.type === 'acp' ? config.mcpSessionServers : undefined,
    mcpSessionExtensions: config?.type === 'acp' ? config.mcpSessionExtensions : undefined,
    contextUsage: config?.type === 'acp' ? config.contextUsage : undefined,
    libraryMcp: config?.libraryMcp,
    mcpSessionLibrary: config?.mcpSessionLibrary,
    initialQueue: initialQueueFromRow(row),
    messageOutbox: row.providerSessionId === null ? config?.messageOutbox : undefined,
    resume: resume,
    lastInteractedAt: row.lastInteractedAt ?? null,
    agentStatus: parseAgentStatus(row.agentStatus),
    agentStatusDetail: parseAgentStatusDetail(row.agentStatusDetail, parseAgentStatus(row.agentStatus)),
    agentStatusSeen: row.agentStatusSeen === 1,
    ...(row.agentStatus === 'error' ? interruptedBy(row.id) : {}),
    runtime: (row.runtime as SessionRuntime | null) ?? 'pty',
    isPinned: row.isPinned === 1,
    archivedAt: row.archivedAt ?? null,
    parentSessionId: sessionParentId(row),
    spawnedBySessionId: sessionSpawnerId(row),
    spawnedByExtensionId: row.spawnedByExtensionId,
    // 谱系两种 runtime 都有(spec session-fork-share「任意会话可 fork」),
    // ❌ 别再只读 pty 那一支:ACP 分叉会因此在侧栏丢掉「fork 自 ×」。
    forkedFrom: config?.forkedFrom,
    forkFromProviderSessionId: config?.type === 'acp' ? config.forkFromProviderSessionId : undefined,
    providerSessionEndpoint: config?.providerSessionEndpoint,
    providerMintedSessionId: config?.providerMintedSessionId,
    agentDisplayName: config?.agentDisplayName,
    // 重来靠的那句话:载荷里还留着的优先(它本来就是要投递的那句),否则用创建时记下的事实。
    // 口径与 restartSession 完全一致 —— 界面据此决定摆「重来」还是「删掉」。
    firstUtterance: config?.initialPrompt?.trim() || config?.firstUtterance?.trim() || undefined,
    startupOrigin: config?.startupOrigin,
    initialMessageId: config?.initialMessageId,
    taskChatId: config?.taskChatId,
  };
}
