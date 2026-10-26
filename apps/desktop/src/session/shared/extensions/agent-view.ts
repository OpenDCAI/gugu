import type { SessionFailure, SessionSummary } from '@gugu/session-core/acp';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import type { ExtensionAgentView } from './bridge-protocol';

export type ListedSession = { session: SessionpageSessionSummary; deviceId: string | null; deviceLabel: string | null };

/**
 * Live counters exist only where there is a live ACP session to count.
 *
 * That is narrower than "panel sessions": a terminal session never has one, and
 * a panel session that is not currently open does not have one *yet*. Both come
 * back `null` rather than `0`, because「一个都没有」and「问不出来」are different
 * answers and a surface that draws a badge must be able to tell them apart
 * (behavior:「如实给空,❌ 凑一个数字冒充」).
 *
 * ❌ 别把这个函数改成按 transport 判断:那会让一条冷的面板会话报出 `0`,即
 * 「我问过了,确实没有」——而其实没人问得到。
 */
function countersFor(
  summary: { pendingPermissionCount: number; queuedPromptCount: number } | undefined
): Pick<ExtensionAgentView, 'pendingPermissionCount' | 'queuedPromptCount'> {
  if (!summary) return { pendingPermissionCount: null, queuedPromptCount: null };
  return {
    pendingPermissionCount: summary.pendingPermissionCount,
    queuedPromptCount: summary.queuedPromptCount,
  };
}

/**
 * Why its engine went away (`lifecycle: 'lost'`), in the runtime's own words: the process exited (code / signal), or the
 * session never started. `start-failed`'s structured error stays inside — its shape is the runtime's, not this surface's.
 */
function failureOf(failure: SessionFailure | null | undefined): ExtensionAgentView['failure'] {
  if (!failure) return null;
  if (failure.kind === 'adapter-exit') {
    return { kind: failure.kind, message: failure.message, exitCode: failure.exitCode, signal: failure.signal ?? null };
  }
  return { kind: failure.kind, message: failure.message, exitCode: null, signal: null };
}

/**
 * 一行会话换成 App 看到的那一行。只有这台机器读得到的活读数(`live`:ACP 活会话摘要与模型)别的机器的行没有 ——
 * 那几格给 null =「问不出来」,❌ 凑一个值。
 */
export function agentViewOf(
  row: ListedSession,
  agentOf: ReadonlyMap<string, string>,
  extensionId: string,
  live: { summary: SessionSummary | undefined; model: string | null } | null,
): ExtensionAgentView | null {
  const { session } = row;
  const agentId = agentOf.get(session.conversationId);
  if (!agentId) return null;
  const summary = live?.summary;
  return {
    agentId,
    sessionId: session.conversationId,
    deviceId: row.deviceId,
    deviceLabel: row.deviceLabel,
    projectId: session.projectId,
    title: session.title,
    // 列表里没有 provider 的会话写 'unknown';这个面上它是 null(一个类型说「一定有」、运行时给空的字段,扩展会当真)。
    providerId: session.harness === 'unknown' ? null : session.harness,
    model: live?.model ?? null,
    // 集体记忆对账第 4 条:和 session_get / session_spawn / spawnAgent 同一套词,App 照抄 row.transport 去 spawnAgent 才不会被拒。
    transport: session.runtime === 'acp' ? 'acp' : 'pty',
    parentAgentId: session.parentConversationId ? (agentOf.get(session.parentConversationId) ?? null) : null,
    // 只说「是不是我起的」,❌ 给出别的扩展的 id:装了哪些别的扩展不是这个扩展该知道的事。
    spawnedByThisExtension: session.spawnedByExtensionId === extensionId,
    status: session.status?.status ?? null,
    detail: session.status?.detail ?? null,
    isGenerating: summary?.isGenerating ?? null,
    lastStopReason: summary?.lastStopReason ?? null,
    failure: failureOf(summary?.failure),
    lastActionAt: typeof summary?.lastActionAt === 'number' ? new Date(summary.lastActionAt).toISOString() : null,
    updatedAt: session.lastInteractedAt ?? null,
    contextTokens: summary?.contextTokens ?? null,
    // ISO like `updatedAt` and `startedAt`: one way to write a time on this surface.
    rateLimit: summary?.rateLimit
      ? { ...summary.rateLimit, resetsAt: summary.rateLimit.resetsAt === null ? null : new Date(summary.rateLimit.resetsAt).toISOString() }
      : null,
    ...countersFor(summary),
  };
}
