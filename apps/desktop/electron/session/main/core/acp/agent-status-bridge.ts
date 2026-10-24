import { sessionSummarySchema, type SessionSummary } from '@gugu/session-core/acp';
import type { Unsubscribe } from '@gugu/session-shared';
import { ReplicaState } from '@gugu/session-wire';
import { z } from 'zod';
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { isAppFocused } from '@main/core/agent-hooks/app-focus';
import { log } from '@main/lib/logger';
import { applyHarnessTitle } from '../sessions/renameSession';
import { SessionActivityObserver } from '../activity/session-observation';
import {
  applyContextUsageChange,
  contextUsageChange,
  readRecordedContextUsage,
  type ContextReading,
} from '../sessions/record-context-usage';
import { deriveAcpAgentStatusActions, type AcpAgentStatusAction } from './agent-status-transition';
import { initializeAcpRuntimeProcess, onAcpRuntimeSpawned } from './controller';

type SessionSummaryList = Record<string, SessionSummary>;

const sessionSummaryListSchema = z.record(z.string(), sessionSummarySchema);

class AcpAgentStatusBridge {
  private readonly activity = new SessionActivityObserver();
  private readonly summaries = new Map<string, SessionSummary>();
  /**
   * #7342 记录里每条会话那份上下文读数的影子:摘要每个 token 都会来一份,判要不要写只比内存,
   * 库只在第一次见到这条会话时读一次。会话停掉(摘要消失)就忘掉,下次起来重读。
   */
  private readonly recordedUsage = new Map<string, ContextReading | null>();
  private processExitUnsubscribe: Unsubscribe | null = null;
  private replica: ReplicaState<SessionSummaryList> | null = null;
  private attaching = false;
  /** 接的过程中又起来了一个运行时:这一次接完,它若不是接上的那个,再接一次。 */
  private queuedRuntime: object | null = null;
  private spawnedUnsubscribe: Unsubscribe | null = null;
  /** 此刻接着的那个运行时(它的 `process`,只作身份用)。 */
  private attachedRuntime: object | null = null;

  /**
   * 开机先接一次;此后**每起来一个运行时**都重新接上。开机那次可能没起来(冷机超过就绪预算),
   * 稍后会话启动把运行时拉起来、回合照跑 —— 只接一次的话,从那以后这台机器上所有 ACP 会话的状态都停在原地,
   * 设备摘要里永远 idle,管家据此把正在干活的机器睡掉(#7199)。
   */
  initialize(): void {
    this.spawnedUnsubscribe = onAcpRuntimeSpawned((runtime) => this.connect(runtime));
    this.connect(null);
  }

  dispose(): void {
    this.activity.dispose();
    this.spawnedUnsubscribe?.();
    this.spawnedUnsubscribe = null;
    this.processExitUnsubscribe?.();
    this.processExitUnsubscribe = null;
    this.detach();
  }

  /** `runtime`:起来的那个运行时(开机那次是 null,接谁由 `get()` 定)。已经接在它上面就不动。 */
  private connect(runtime: object | null): void {
    if (runtime !== null && runtime === this.attachedRuntime) return;
    if (this.attaching) {
      this.queuedRuntime = runtime ?? this.queuedRuntime;
      return;
    }
    void this.attach()
      .catch((error) => {
        // 不重试:下一个起来的运行时会再叫到这里(会话启动就会拉起它)。
        log.warn('ACP agent status bridge failed to attach; it attaches when the runtime next comes up', {
          error: String(error),
        });
      })
      .finally(() => {
        const queued = this.queuedRuntime;
        this.queuedRuntime = null;
        if (queued !== null && this.spawnedUnsubscribe) this.connect(queued);
      });
  }

  /** 此刻运行时里的 ACP 会话摘要(按 conversationId),只读。闲置回收按它找「进程还在」的会话。 */
  current(): ReadonlyMap<string, SessionSummary> {
    return this.summaries;
  }

  private async attach(): Promise<void> {
    if (this.attaching) return;
    this.attaching = true;
    try {
      this.detach();
      const handle = await initializeAcpRuntimeProcess();
      this.processExitUnsubscribe = handle.process.onExit((exit) => {
        if (exit.willRestart) return;
        void this.resetAll().catch((error) => {
          log.warn('ACP agent status bridge failed to reset statuses on disconnect', {
            error: String(error),
          });
        });
        this.detach();
      });
      const replica = new ReplicaState<SessionSummaryList>(
        handle.client.sessions.state(undefined, 'list'),
        {
          schema: sessionSummaryListSchema,
          onChange: (summaries) => void this.applySummaries(summaries),
        }
      );
      await replica.ready;
      this.replica = replica;
      this.attachedRuntime = handle.process;
      // 接晚了(运行时比这里先起、回合已经在跑)也一样:当前摘要对着上一份比,在跑的那条照样报出开工。
      this.applySummaries(replica.current());
    } finally {
      this.attaching = false;
    }
  }

  private detach(): void {
    this.attachedRuntime = null;
    this.processExitUnsubscribe?.();
    this.processExitUnsubscribe = null;
    const replica = this.replica;
    this.replica = null;
    if (replica) void replica.dispose();
  }

  private applySummaries(nextSummaries: SessionSummaryList): void {
    const seen = new Set<string>();
    for (const summary of Object.values(nextSummaries)) {
      seen.add(summary.sessionId);
      const previous = this.summaries.get(summary.sessionId);
      this.activity.observe(previous, summary);
      this.applyActions(this.derive(previous, summary));
      if (summary.title && summary.title !== previous?.title) this.applyTitle(summary);
      this.applyContextUsage(summary);
      this.summaries.set(summary.sessionId, summary);
    }

    for (const [sessionId, summary] of [...this.summaries]) {
      if (seen.has(sessionId)) continue;
      this.applyActions(this.derive(summary, undefined));
      this.summaries.delete(sessionId);
      this.activity.forget(sessionId);
      this.recordedUsage.delete(sessionId);
    }
  }

  /**
   * 摘要与 machine 对不上(一轮结束了却没有结局)时投影会抛:响亮记下这一条会话,❌ 让它打断同一批里别的会话,
   * 也 ❌ 替它猜一个结局 —— 这条会话的状态停在原处,日志里有原因。
   */
  private derive(previous: SessionSummary | undefined, next: SessionSummary | undefined): AcpAgentStatusAction[] {
    try {
      return deriveAcpAgentStatusActions(previous, next);
    } catch (error) {
      log.error('ACP agent status bridge could not project a session summary', {
        sessionId: (next ?? previous)?.sessionId,
        error: String(error),
      });
      return [];
    }
  }

  /**
   * harness 经 ACP `session_info_update` 报来的标题(它自己拟的)→ 会话标题。优先级在写入点判:
   * 显式命名的会话不动,首轮兜底与 harness 上一次的名会被盖掉。
   */
  private applyTitle(summary: SessionSummary): void {
    try {
      applyHarnessTitle(summary.sessionId, summary.title ?? '');
    } catch (error) {
      log.warn('ACP agent status bridge failed to apply the harness session title', {
        sessionId: summary.sessionId,
        error: String(error),
      });
    }
  }

  /** 一轮落定时把最后那份上下文读数记进会话记录,换了模型就作废 —— 判据在 `contextUsageChange`。 */
  private applyContextUsage(summary: SessionSummary): void {
    try {
      const { sessionId } = summary;
      const recorded = this.recordedUsage.has(sessionId)
        ? (this.recordedUsage.get(sessionId) ?? null)
        : readRecordedContextUsage(sessionId);
      const change = contextUsageChange(recorded, summary);
      // 影子记**判过的结论**,不论写没写成(行没了 / 不是通用模式):❌ 下一份摘要再判一遍、再撞一次库。
      this.recordedUsage.set(sessionId, change ? (change.kind === 'write' ? change.reading : null) : recorded);
      if (change) applyContextUsageChange(sessionId, change);
    } catch (error) {
      log.warn('ACP agent status bridge failed to record the session context usage', {
        sessionId: summary.sessionId,
        error: String(error),
      });
    }
  }

  private applyActions(actions: AcpAgentStatusAction[]): void {
    for (const action of actions) {
      if (action.kind === 'event') {
        agentHookService.emitAgentEvent(action.event, isAppFocused());
      } else {
        void agentStatusWriter
          .interrupt({
            sessionId: action.sessionId,
            projectId: action.projectId,
          })
          .catch((error) => {
            log.warn('ACP agent status bridge failed to reset session status', {
              sessionId: action.sessionId,
              error: String(error),
            });
          });
      }
    }
  }

  private async resetAll(): Promise<void> {
    const summaries = [...this.summaries.values()];
    this.summaries.clear();
    this.recordedUsage.clear();
    await Promise.all(
      summaries.map((summary) =>
        agentStatusWriter.interrupt({
          sessionId: summary.sessionId,
          projectId: summary.projectId,
        })
      )
    );
  }
}

export const acpAgentStatusBridge = new AcpAgentStatusBridge();
