import { eq } from 'drizzle-orm';
import type { SessionSummary } from '@gugu/session-core/acp';
import { acpAgentStatusBridge } from '@main/core/acp/agent-status-bridge';
import { assertHarnessConnectionSelectable, selectHarnessConnection } from '@main/core/agents/harness-connections';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { parsePtySessionId } from '@shared/core/pty/ptySessionId';
import { sessionReclaimedChannel } from '@shared/core/sessions/provisionEvents';
import { stopExactSessionpageSession } from './session-orchestration';
import { SubscriptionSessionsBusyError } from './subscription-sessions-busy';

type SubscriptionProvider = 'claude' | 'codex';
type LiveSession = { projectId: string; sessionId: string; busy: boolean };

const ACP_LIVE = new Set<SessionSummary['lifecycle']>(['starting', 'replaying', 'ready', 'working', 'cancelling']);
/** 停一条会话等它的进程退出,一轮最多 10 s(`stop_pending` = 信号发了、还没退)。几轮都没退才报失败。 */
const STOP_ATTEMPTS = 3;

/**
 * 停掉它会不会丢掉手上的活。还在起、还在回放的不算:停掉不丢任何一轮,下一条消息照样接着原对话起。
 * 10-30 实例:重启后咕咕给 9 个欠着消息的 Codex 会话补投、同时冷启动卡了 7 分钟,这 7 分钟切换一律被拒。
 */
function acpBusy(summary: SessionSummary): boolean {
  return summary.lifecycle === 'working'
    || summary.lifecycle === 'cancelling'
    || summary.isGenerating
    || summary.pendingPermissionCount > 0
    || summary.queuedPromptCount > 0
    || summary.backgroundAgentCount > 0
    || summary.backgroundCommandCount > 0;
}

/** 此刻进程在跑的这一家的会话(两种腿);它们都跑在用户的配置根上。 */
function liveSessions(providerId: SubscriptionProvider): LiveSession[] {
  const live = new Map<string, LiveSession>();
  for (const summary of acpAgentStatusBridge.current().values()) {
    if (summary.providerId !== providerId || !ACP_LIVE.has(summary.lifecycle)) continue;
    live.set(summary.sessionId, { projectId: summary.projectId, sessionId: summary.sessionId, busy: acpBusy(summary) });
  }
  for (const pty of ptySessionRegistry.listActiveSessions()) {
    if (pty.metadata?.providerId !== providerId) continue;
    const parsed = parsePtySessionId(pty.ptySessionId);
    if (!parsed) continue;
    const status = db.select({ status: sessions.agentStatus }).from(sessions).where(eq(sessions.id, parsed.leafId)).get()?.status;
    live.set(parsed.leafId, { projectId: parsed.projectId, sessionId: parsed.leafId, busy: status === 'working' || status === 'needs_user' });
  }
  return [...live.values()];
}

/** 停不下来先别放弃:`stop_pending` 是进程收到信号还没退,再等一轮。别的失败照抛。 */
async function stopForSwitch(session: LiveSession): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await stopExactSessionpageSession(session);
    } catch (error) {
      const pending = typeof error === 'object' && error !== null && 'code' in error && error.code === 'stop_pending';
      if (!pending || attempt >= STOP_ATTEMPTS) throw error;
    }
  }
}

/**
 * 切换 Claude / Codex 默认订阅(#26,照 cockpit-tools「切号后重启客户端」):
 *
 * 1. 有会话正在干活就先不切 —— 停掉它会丢掉这一轮;用户看过提示仍要切(`stopBusySessions`)就连它们一起关掉。
 *    额度用完正是要切号的时候,这时手上的回合本来也跑不下去,所以拒绝必须带着一键关掉的出路;
 * 2. 先停掉其余在跑的这一家的会话,再换凭据。旧进程活着时会原地刷新 token、把旧账号写回用户根,
 *    换进去的新账号就被它盖掉了;它也不会自己认出换了人;
 * 3. 停掉的会话放回「重启之后还没打开过」的样子,下一条消息用新订阅接着原对话跑。
 */
export async function switchSubscription(
  providerId: SubscriptionProvider,
  connectionId: string,
  nativeEnv: Record<string, string | undefined>,
  options: { stopBusySessions?: boolean } = {}
): Promise<void> {
  const live = liveSessions(providerId);
  const busy = live.filter((session) => session.busy).length;
  if (busy > 0 && !options.stopBusySessions) throw new SubscriptionSessionsBusyError(providerId, busy);
  // 换不成(连接没了、登录没存、Codex 凭据不在文件里)就在停会话之前报出来。
  await assertHarnessConnectionSelectable(providerId, connectionId, { nativeEnv });
  const stopped: LiveSession[] = [];
  try {
    for (const session of live) {
      if (await stopForSwitch(session)) stopped.push(session);
    }
    await selectHarnessConnection(providerId, connectionId, { nativeEnv });
  } finally {
    for (const session of stopped) events.emit(sessionReclaimedChannel, { projectId: session.projectId, sessionId: session.sessionId });
    if (stopped.length > 0) {
      log.warn('subscription switch: restarted running sessions', { providerId, count: stopped.length, busy, connectionId });
    }
  }
}
