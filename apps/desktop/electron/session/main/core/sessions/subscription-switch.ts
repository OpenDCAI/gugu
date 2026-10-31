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
import { subscriptionSwitchProgressChannel } from '@shared/core/sessions/subscriptionSwitchEvents';
import { stopExactSessionpageSession } from './session-orchestration';
import { SubscriptionSessionsBusyError } from './subscription-sessions-busy';
import { sessionLife } from './session-life';

type SubscriptionProvider = 'claude' | 'codex';
type LiveSession = { projectId: string; sessionId: string; busy: boolean; acp: boolean };

/** 停一条会话等它的进程退出,一轮最多 10 s(`stop_pending` = 信号发了、还没退)。几轮都没退才报失败。 */
const STOP_ATTEMPTS = 3;

function acpBusy(summary: SessionSummary | undefined): boolean {
  return summary === undefined || summary.lifecycle !== 'ready'
    || summary.isGenerating
    || summary.pendingPermissionCount > 0
    || summary.queuedPromptCount > 0
    || summary.backgroundAgentCount > 0
    || summary.backgroundCommandCount > 0;
}

/** 此刻进程在跑的这一家的会话(两种腿);它们都跑在用户的配置根上。 */
function liveSessions(providerId: SubscriptionProvider): LiveSession[] {
  const live = new Map<string, LiveSession>();
  // ACP: session-life says which sessions have a run; the runtime summary says only whether it is busy.
  const summaries = acpAgentStatusBridge.current();
  // A side chat runs the same harness on the same config root as its session: it stops too.
  for (const { sessionId, parentId } of sessionLife().running()) {
    const recordId = parentId ?? sessionId;
    const row = db.select({ projectId: sessions.projectId, provider: sessions.provider }).from(sessions).where(eq(sessions.id, recordId)).get();
    if (!row) throw new Error(`subscription switch: running session ${recordId} has no row`);
    if (row.provider !== providerId) continue;
    live.set(sessionId, { projectId: row.projectId, sessionId, busy: acpBusy(summaries.get(sessionId)), acp: true });
  }
  for (const pty of ptySessionRegistry.listActiveSessions()) {
    if (pty.metadata?.providerId !== providerId) continue;
    const parsed = parsePtySessionId(pty.ptySessionId);
    if (!parsed) continue;
    const status = db.select({ status: sessions.agentStatus }).from(sessions).where(eq(sessions.id, parsed.leafId)).get()?.status;
    live.set(parsed.leafId, { projectId: parsed.projectId, sessionId: parsed.leafId, busy: status === 'working' || status === 'needs_user', acp: false });
  }
  return [...live.values()];
}

/** 停不下来先别放弃:`stop_pending` 是进程收到信号还没退,再等一轮。别的失败照抛。 */
async function stopForSwitch(session: LiveSession): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await stopExactSessionpageSession({ ...session, reason: 'version-switch' });
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
  const progress = (closed: number) => {
    if (live.length > 0) events.emit(subscriptionSwitchProgressChannel, { providerId, closed, total: live.length });
  };
  const acp = live.filter((session) => session.acp);
  const terminals = live.filter((session) => !session.acp);
  try {
    progress(0);
    // ACP sessions (side chats too) are held through the swap by session-life's sign-out window, scoped to them: none
    // restarts on the old credentials, and the ones with queued input start on the new ones once it closes (v3.2).
    await sessionLife().rotate(acp.map((session) => session.sessionId), async () => {
      stopped.push(...acp);
      progress(acp.length);
      for (const [index, session] of terminals.entries()) {
        if (await stopForSwitch(session)) stopped.push(session);
        progress(acp.length + index + 1);
      }
      await selectHarnessConnection(providerId, connectionId, { nativeEnv });
    });
  } finally {
    for (const session of stopped) events.emit(sessionReclaimedChannel, { projectId: session.projectId, sessionId: session.sessionId });
    if (stopped.length > 0) {
      log.warn('subscription switch: restarted running sessions', { providerId, count: stopped.length, busy, connectionId });
    }
  }
}
