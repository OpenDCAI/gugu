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

type SubscriptionProvider = 'claude' | 'codex';
type LiveSession = { projectId: string; sessionId: string; busy: boolean };

const LABEL: Record<SubscriptionProvider, string> = { claude: 'Claude', codex: 'Codex' };
const ACP_LIVE = new Set<SessionSummary['lifecycle']>(['starting', 'replaying', 'ready', 'working', 'cancelling']);

function acpBusy(summary: SessionSummary): boolean {
  return summary.lifecycle !== 'ready'
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

/**
 * 切换 Claude / Codex 默认订阅(#26,照 cockpit-tools「切号后重启客户端」):
 *
 * 1. 有会话正在干活就不切 —— 停掉它会丢掉这一轮;
 * 2. 先停掉其余在跑的这一家的会话,再换凭据。旧进程活着时会原地刷新 token、把旧账号写回用户根,
 *    换进去的新账号就被它盖掉了;它也不会自己认出换了人;
 * 3. 停掉的会话放回「重启之后还没打开过」的样子,下一条消息用新订阅接着原对话跑。
 */
export async function switchSubscription(
  providerId: SubscriptionProvider,
  connectionId: string,
  nativeEnv: Record<string, string | undefined>
): Promise<void> {
  const live = liveSessions(providerId);
  const busy = live.filter((session) => session.busy).length;
  if (busy > 0) {
    throw new Error(
      `${busy} ${LABEL[providerId]} session${busy === 1 ? ' is' : 's are'} still working. ` +
        `Switch the subscription after they finish; switching restarts every running ${LABEL[providerId]} session.`
    );
  }
  // 换不成(连接没了、登录没存、Codex 凭据不在文件里)就在停会话之前报出来。
  await assertHarnessConnectionSelectable(providerId, connectionId, { nativeEnv });
  const stopped: LiveSession[] = [];
  try {
    for (const session of live) {
      if (await stopExactSessionpageSession(session)) stopped.push(session);
    }
    await selectHarnessConnection(providerId, connectionId, { nativeEnv });
  } finally {
    for (const session of stopped) events.emit(sessionReclaimedChannel, { projectId: session.projectId, sessionId: session.sessionId });
    if (stopped.length > 0) {
      log.warn('subscription switch: restarted running sessions', { providerId, count: stopped.length, connectionId });
    }
  }
}
