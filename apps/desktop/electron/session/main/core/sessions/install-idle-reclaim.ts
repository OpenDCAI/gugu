import { eq } from 'drizzle-orm';
import type { SessionSummary } from '@gugu/session-core/acp';
import { acpAgentStatusBridge } from '@main/core/acp/agent-status-bridge';
import { closeSessionBrowserTools } from '../../../../browser-agent-mcp';
import { currentOrLastSession } from '@main/core/extensions/extension-bridge';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { decodeTmuxSessionName, getConfiguredTmuxSocketLabel, listTmuxSessionNames } from '@main/core/pty/tmux-session-name';
import { sharedRemotePaneRoute } from '@main/core/session-timeline/remote-pane';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { onConfirmedSleep } from '@main/core/activity/confirmed-sleep';
import { parsePtySessionId } from '@shared/core/pty/ptySessionId';
import { sessionReclaimedChannel } from '@shared/core/sessions/provisionEvents';
import {
  IDLE_RECLAIM_TICK_MS,
  IdleReclaimer,
  type SessionFacts,
  type LiveSession,
} from './idle-reclaim';
import { stopExactSessionpageSession } from './session-orchestration';
import { sessionOnScreen } from './sessions-on-screen';
import { tuiResumesExactly } from './tui-resume-exactness';
import { mapSessionRowToSession } from './utils';

/** 进程还在的 ACP 生命周期(`lost` = 适配器已退出,`closed` 的摘要停掉时已删)。 */
const ACP_LIVE = new Set<SessionSummary['lifecycle']>(['starting', 'replaying', 'ready', 'working', 'cancelling']);

function acpAtRest(summary: SessionSummary): boolean {
  return summary.lifecycle === 'ready'
    && !summary.closing
    && !summary.isGenerating
    && summary.pendingPermissionCount === 0
    && summary.queuedPromptCount === 0
    && summary.backgroundAgentCount === 0
    && summary.backgroundCommandCount === 0
    && summary.canLoadSession === true;
}

/** 此刻进程在跑的会话(两种腿),以及开着终端 shell 的任务。 */
async function readLive(): Promise<{ live: LiveSession[]; withTerminals: Set<string> }> {
  const live: LiveSession[] = [];
  for (const summary of acpAgentStatusBridge.current().values()) {
    if (!ACP_LIVE.has(summary.lifecycle)) continue;
    live.push({
      projectId: summary.projectId,
      sessionId: summary.sessionId,
      runtime: 'acp',
      acpAtRest: acpAtRest(summary),
    });
  }
  // 终端 pty 的中间段是它所属会话的 id(生命周期脚本那几个是工作区 id,碰不上任何会话)。
  const withTerminals = new Set<string>();
  for (const session of ptySessionRegistry.listActiveSessions()) {
    const parsed = parsePtySessionId(session.ptySessionId);
    if (!parsed) continue;
    // 会话的 pty 注册时带着 providerId;其余(终端抽屉、生命周期脚本)都是用户自己的 shell。
    if (!session.metadata?.providerId) {
      withTerminals.add(parsed.scopeId);
      continue;
    }
    live.push({ projectId: parsed.projectId, sessionId: parsed.leafId, runtime: 'pty' });
  }
  // tmux outlives this host: tasks not reattached since restart have no PTY registry entry.
  if (getConfiguredTmuxSocketLabel()) {
    const known = new Set(live.map((entry) => entry.sessionId));
    for (const name of await listTmuxSessionNames(new LocalExecutionContext())) {
      const id = decodeTmuxSessionName(name);
      const parsed = id ? parsePtySessionId(id) : null;
      if (!parsed) continue;
      if (parsed.scopeId !== parsed.leafId) withTerminals.add(parsed.scopeId);
      else if (!known.has(parsed.leafId)) {
        known.add(parsed.leafId);
        live.push({ projectId: parsed.projectId, sessionId: parsed.leafId, runtime: 'pty' });
      }
    }
  }
  return { live, withTerminals };
}

function readFacts(sessionId: string): SessionFacts | null {
  const [row] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
  if (!row || row.archivedAt) return null;
  const config = row.config;
  // 恢复不回来的一律不停:provider session 已丢 / 等着重开 / 还在起动。
  const settled = !config?.providerSessionState && !config?.pendingRestart && config?.spawnStartupState !== 'starting';
  let resumable = false;
  if (settled) {
    if (row.runtime === 'acp') {
      resumable = !!row.providerSessionId;
    } else {
      try {
        resumable = tuiResumesExactly(mapSessionRowToSession(row));
      } catch {
        resumable = false;
      }
    }
  }
  return { status: row.agentStatus, resumable };
}

type StatusSource = {
  on(name: 'agent:status', handler: (input: { sessionId: string; reading: { status: string } }) => void): unknown;
};

let installed = false;

/** 开机时装一次(embedded-boot,紧挨着用量记账):订状态写入者的输出,起 60 秒一次的扫描。 */
export function installIdleReclaim(sources: { agentStatus: StatusSource }): () => void {
  if (installed) return () => {};
  installed = true;
  let withTerminals = new Set<string>();
  const reclaimer = new IdleReclaimer({
    now: () => Date.now(),
    listLive: async () => {
      const read = await readLive();
      withTerminals = read.withTerminals;
      return read.live;
    },
    facts: readFacts,
    // 屏上的每一条(主窗那页、会话页上每一块、单独的窗、开在窗里的页签,渲染层报来的),加上最后显示的那条
    // (人离开了会话页,刚才看的那条仍留着,#6387)。❌ 只认主窗那一页:页签开在新窗口里审阅的会话会被当成没人看停掉。
    onScreen: (sessionId) => sessionOnScreen(sessionId) || currentOrLastSession()?.sessionId === sessionId,
    watchedRemotely: (sessionId) => sharedRemotePaneRoute().watching(sessionId),
    sessionsWithLiveTerminals: () => withTerminals,
    stop: async (target) => {
      if (!(await stopExactSessionpageSession({ ...target, reason: 'idle-reap' }))) {
        throw new Error('session row is gone');
      }
      await closeSessionBrowserTools(target.sessionId);
    },
    reclaimed: (target) => events.emit(sessionReclaimedChannel, target),
    log: (event, fields) => {
      // 停掉的是用户的进程,事后排查「怎么突然重开了」只能靠这一行 → warn:会话这半边默认只落 warn 及以上,info 落不了盘。
      if (event === 'reclaimed') log.warn('idle reclaim: released idle session resources', fields);
      else log.warn('idle reclaim: stopping an idle session failed; it keeps running', fields);
    },
  });
  sources.agentStatus.on('agent:status', ({ sessionId, reading }) =>
    reclaimer.observeStatus(sessionId, reading.status)
  );
  const timer = setInterval(() => {
    void reclaimer.tick().catch((error: unknown) => log.warn('idle reclaim: could not read live session processes', { error: String(error) }));
  }, IDLE_RECLAIM_TICK_MS);
  const offResume = onConfirmedSleep(sleep => reclaimer.resumedFromConfirmedSleep(sleep));
  timer.unref?.();
  return () => {
    clearInterval(timer);
    offResume();
    installed = false;
  };
}
