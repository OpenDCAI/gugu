import { log } from '@main/lib/logger';
import type { Automation } from '@shared/core/automations/automation';
import type { AutomationRun } from '@shared/core/automations/automation-run';
export { automationRunDeadline } from './repo';
import {
  enabledAutomationsWithoutQueuedRun,
  ensureNextCronRun,
  findRunsStuckInStartingAgent,
  findRunsStuckInCreatingSession,
  findRunsStuckInLaunchingSession,
  getAutomation,
  listQueuedRuns,
  closeSpentOneTimeAutomation,
  markDueCronRunsQueued,
  nextScheduledRunAt,
  startCreatingSession,
} from './repo';
import { markRunFailed, markRunSkipped, type OnStepCompleted } from './run-transitions';
import { runQueuedAutomation, type AutomationRunExecutor } from './runtime';
import { prepareAgentScheduleChanges } from './assistant-panel-schedule-preparation';

const TICK_MS = 60_000;
// 每分钟整点之后这么久扫一次:排定的时刻都落在整分钟上(cron 最细到分;一次性的 `at` 默认也是),
// 扫描对齐到整分,到点的就在一秒左右被看见,❌ 按进程起来的那一刻起算、最多晚一整分钟(#7221 云电脑实测晚 45 秒)。
const TICK_AFTER_MINUTE_MS = 1_000;

/** 从 `now` 到下一次扫描:下一个整分钟再过 TICK_AFTER_MINUTE_MS。 */
export function msUntilNextTick(now: number): number {
  const sinceMinute = now % TICK_MS;
  const wait = TICK_AFTER_MINUTE_MS - sinceMinute;
  return wait > 0 ? wait : wait + TICK_MS;
}
const MAX_DUE_ENQUEUE = 100;
// Each run may allocate a worktree, PTY and agent process; keep local fan-out conservative.
const MAX_CONCURRENT_RUNS = 4;

export interface SchedulerCallbacks {
  onRunStep: OnStepCompleted;
  onScheduledRunChanged: (automationId: string) => void;
}

class SlotPool {
  private activeCount = 0;

  constructor(
    private readonly limit: number,
    private readonly onSlotFreed: () => void
  ) {}

  get availableSlots(): number {
    return Math.max(0, this.limit - this.activeCount);
  }

  start(task: () => Promise<void>): boolean {
    if (this.availableSlots <= 0) return false;
    this.activeCount += 1;
    void task().finally(() => {
      this.activeCount -= 1;
      this.onSlotFreed();
    });
    return true;
  }
}

export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null;
  /** 排程带秒(如 15:58:25)时的准点唤醒;整分钟那次扫描一秒内就能看见的不另起。 */
  private dueTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickTail: Promise<void> = Promise.resolve();
  private drainTail: Promise<void> = Promise.resolve();
  private bootstrapTail: Promise<void> = Promise.resolve();
  private readonly deliveryRetryAfter = new Map<string, number>();
  private readonly inFlight = new Set<string>(); // automation IDs currently executing
  private readonly deletingAutomationIds = new Set<string>();
  private readonly slotPool = new SlotPool(MAX_CONCURRENT_RUNS, () => {
    void this.drainQueue();
  });

  constructor(
    private readonly callbacks: SchedulerCallbacks,
    private readonly executor: AutomationRunExecutor = runQueuedAutomation
  ) {}

  start(): void {
    if (this.timer) return;

    this.recoverInterruptedRuns().catch((error) => {
      log.error('AutomationScheduler recovery failed', { error: String(error) });
    });
    this.reload().catch((error) => {
      log.error('AutomationScheduler bootstrap failed', { error: String(error) });
    });
    this.armTick();
  }

  stop(): void {
    if (this.dueTimer) clearTimeout(this.dueTimer);
    this.dueTimer = null;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** 每次扫完按当下的钟重新对齐到下一个整分,❌ setInterval(会从进程起来那一刻起算,还会漂)。 */
  private armTick(): void {
    this.timer = setTimeout(() => {
      this.scanNow();
      this.armTick();
    }, msUntilNextTick(Date.now()));
    this.timer.unref?.();
  }

  private scanNow(): void {
    void prepareAgentScheduleChanges().then(blocked => {
      this.tickTail = Promise.all([this.tickTail, this.tick(blocked)]).then(() => undefined);
      return this.tickTail;
    }).then(() => this.armDueWake())
      .catch(error => log.error('Automation preparation failed',{ error: String(error) }));
  }

  /**
   * 排程可以带秒(agent 排的「15:58:25」):只靠整分钟扫描,它要等到 15:59:01 才被看见,晚 36 秒(MBP 10-28)。
   * ⇒ 最近一条在下一次整分扫描之前、且早于它一秒以上的,到那一刻准点醒一次;整分钟的排程照旧由整分扫描接。
   */
  private async armDueWake(): Promise<void> {
    if (!this.timer) return;
    const now = Date.now();
    const due = await nextScheduledRunAt(now);
    if (!this.timer) return;
    if (this.dueTimer) clearTimeout(this.dueTimer);
    this.dueTimer = null;
    if (due == null) return;
    const wait = Math.max(0, due - Date.now());
    if (wait >= msUntilNextTick(Date.now()) - TICK_AFTER_MINUTE_MS) return;
    this.dueTimer = setTimeout(() => {
      this.dueTimer = null;
      this.scanNow();
    }, wait);
    this.dueTimer.unref?.();
  }

  async reload(): Promise<void> {
    const blocked = await prepareAgentScheduleChanges();
    const run = this.bootstrapTail.then(() => this.bootstrapDueRuns(blocked));
    this.bootstrapTail = run.catch((error) => {
      log.error('AutomationScheduler bootstrap failed', { error: String(error) });
    });
    await this.bootstrapTail;
    // 新排的、改过的排程都经这里(automations-service 改完就 reload):按它重新对准准点唤醒。
    await this.armDueWake().catch((error) => {
      log.error('AutomationScheduler failed to arm the due wake', { error: String(error) });
    });
  }

  async beginAutomationDeletion(automationId: string): Promise<boolean> {
    this.deletingAutomationIds.add(automationId);
    await Promise.all([this.tickTail, this.bootstrapTail, this.drainTail]);
    return !this.inFlight.has(automationId);
  }

  endAutomationDeletion(automationId: string): void {
    this.deletingAutomationIds.delete(automationId);
  }

  /** #7221 见 closeSpentOneTimeAutomation;关了就通知列表刷新,出错只记日志(调度不能因它停)。 */
  private async closeSpentOneTime(automationId: string): Promise<void> {
    try {
      if (await closeSpentOneTimeAutomation(automationId)) {
        this.callbacks.onScheduledRunChanged(automationId);
      }
    } catch (error) {
      log.error('AutomationScheduler failed to close a spent one-time schedule', {
        automationId,
        error: String(error),
      });
    }
  }

  /** Mark all stuck in-progress runs as interrupted so they don't get stuck forever. */
  private async recoverInterruptedRuns(): Promise<void> {
    const now = Date.now();

    const stuckCreating = await findRunsStuckInCreatingSession();
    for (const { id } of stuckCreating) {
      const failed = await markRunFailed(
        id,
        { step: 'create_session', code: 'interrupted_by_restart' },
        now
      );
      this.callbacks.onRunStep(failed);
      await this.closeSpentOneTime(failed.automationId);
    }
    if (stuckCreating.length > 0) {
      log.warn('AutomationScheduler recovered stuck creating_session runs', {
        count: stuckCreating.length,
      });
    }

    const stuckLaunching = await findRunsStuckInLaunchingSession();
    for (const { id } of stuckLaunching) {
      const failed = await markRunFailed(
        id,
        { step: 'launch_session', code: 'interrupted_by_restart' },
        now
      );
      this.callbacks.onRunStep(failed);
    }
    if (stuckLaunching.length > 0) {
      log.warn('AutomationScheduler recovered stuck launching_session runs', {
        count: stuckLaunching.length,
      });
    }

    const stuckSession = await findRunsStuckInStartingAgent();
    for (const { id } of stuckSession) {
      const failed = await markRunFailed(
        id,
        { step: 'start_agent', code: 'interrupted_by_restart' },
        now
      );
      this.callbacks.onRunStep(failed);
    }
    if (stuckSession.length > 0) {
      log.warn('AutomationScheduler recovered stuck starting_agent runs', {
        count: stuckSession.length,
      });
    }
  }

  private async bootstrapDueRuns(blocked: Map<string, Error>): Promise<void> {
    const now = Date.now();

    // Ensure every enabled automation has a scheduled cron run (self-healing).
    const needsScheduled = await enabledAutomationsWithoutQueuedRun();
    await Promise.allSettled(
      needsScheduled.map(async (automation) => {
        if (this.deletingAutomationIds.has(automation.id)) return;
        // #7221 开着、却已过了那一刻也没有运行在等的一次性(上回没收口的):现在收口。
        if (automation.triggerConfig?.at != null && automation.triggerConfig.at <= now) {
          await this.closeSpentOneTime(automation.id);
          return;
        }
        try {
          await ensureNextCronRun(automation, now);
          this.callbacks.onScheduledRunChanged(automation.id);
        } catch (error) {
          log.error('AutomationScheduler failed to ensure next cron run on bootstrap', {
            automationId: automation.id,
            error: String(error),
          });
        }
      })
    );

    // Transition any due scheduled cron runs to queued.
    const transitioned = await markDueCronRunsQueued(now);
    for (const { automation } of transitioned.slice(0, MAX_DUE_ENQUEUE)) {
      if (this.deletingAutomationIds.has(automation.id)) continue;
      await ensureNextCronRun(automation, now)
        .then(() => {
          this.callbacks.onScheduledRunChanged(automation.id);
        })
        .catch((error) => {
          log.error('AutomationScheduler failed to schedule next cron run after transition', {
            automationId: automation.id,
            error: String(error),
          });
        });
    }

    await this.drainQueue(blocked);
  }

  private async tick(blocked: Map<string, Error>): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();

      // Phase 1: transition due scheduled runs → queued and pre-schedule next occurrences.
      const transitioned = await markDueCronRunsQueued(now);
      for (const { automation } of transitioned.slice(0, MAX_DUE_ENQUEUE)) {
        if (this.deletingAutomationIds.has(automation.id)) continue;
        await ensureNextCronRun(automation, now)
          .then(() => {
            this.callbacks.onScheduledRunChanged(automation.id);
          })
          .catch((error) => {
            log.error('AutomationScheduler failed to schedule next cron run', {
              automationId: automation.id,
              error: String(error),
            });
          });
      }

      // Phase 2: drain the queue.
      await this.drainQueue(blocked);
    } catch (error) {
      log.error('AutomationScheduler tick failed', { error: String(error) });
    } finally {
      this.ticking = false;
    }
  }

  async drainQueue(prepared?: Map<string, Error>): Promise<void> {
    const blocked = prepared ?? await prepareAgentScheduleChanges();
    const run = this.drainTail.then(() => this.pumpQueue(blocked));
    this.drainTail = run.catch((error) => {
      log.error('AutomationScheduler queue drain failed', { error: String(error) });
    });
    await this.drainTail;
  }

  private async pumpQueue(blocked: Map<string, Error>): Promise<void> {
    const attempted = new Set<string>();
    for (const [id,after] of this.deliveryRetryAfter) {
      if (after > Date.now()) attempted.add(id); else this.deliveryRetryAfter.delete(id);
    }
    while (this.slotPool.availableSlots > 0) {
      const capacity = this.slotPool.availableSlots;
      const batch = await listQueuedRuns(capacity,[...blocked.keys()],[...attempted]);
      if (batch.length === 0) return;

      let madeProgress = false;
      for (const entry of batch) {
        if (this.slotPool.availableSlots <= 0) return;

        if (this.deletingAutomationIds.has(entry.automation.id)) {
          const skipped = await markRunSkipped(entry.run.id, {
            step: 'queue',
            code: 'automation_deleted',
          });
          this.callbacks.onRunStep(skipped);
          madeProgress = true;
          continue;
        }

        if (entry.run.deadlineAt != null && entry.run.deadlineAt <= Date.now()) {
          const skipped = await markRunSkipped(entry.run.id, {
            step: 'queue',
            code: 'deadline_exceeded',
          });
          this.callbacks.onRunStep(skipped);
          madeProgress = true;
          continue;
        }

        if (entry.automation.projectId == null && !entry.automation.agentSessionId) {
          const skipped = await markRunSkipped(entry.run.id, { step: 'queue', code: 'no_project' });
          this.callbacks.onRunStep(skipped);
          madeProgress = true;
          continue;
        }

        if (this.inFlight.has(entry.automation.id)) {
          const skipped = await markRunSkipped(entry.run.id, {
            step: 'queue',
            code: 'previous_running',
          });
          this.callbacks.onRunStep(skipped);
          madeProgress = true;
          continue;
        }

        const run = await startCreatingSession(entry.run.id);
        if (!run) continue;

        madeProgress = true;
        attempted.add(run.id);
        this.callbacks.onRunStep(run);
        this.inFlight.add(entry.automation.id);
        this.slotPool.start(() => this.runWorker(entry.automation, run));
      }

      if (!madeProgress) return;
    }
  }

  /**
   * Execute a manual run immediately, bypassing the cron queue.
   * The run should already be in `creating_session` status when this is called.
   */
  executeNow(automation: Automation, run: AutomationRun): void {
    if (this.deletingAutomationIds.has(automation.id)) {
      throw new Error('automation_deletion_in_progress');
    }
    if (this.inFlight.has(automation.id)) {
      log.warn('AutomationScheduler.executeNow: automation already in flight', {
        automationId: automation.id,
        runId: run.id,
      });
    }
    this.inFlight.add(automation.id);
    void this.runWorker(automation, run).catch((error) => {
      log.error('AutomationScheduler.executeNow worker failed', {
        automationId: automation.id,
        runId: run.id,
        error: String(error),
      });
    });
  }

  private async runWorker(automation: Automation, run: AutomationRun): Promise<void> {
    const current = await getAutomation(automation.id);
    if (!current) {
      const skipped = await markRunSkipped(run.id, { step: 'queue', code: 'automation_deleted' });
      this.callbacks.onRunStep(skipped);
      return;
    }
    try {
      const result = await this.executor(current, run, this.callbacks.onRunStep);
      if (!result.success && result.error === 'delivery_not_admitted') this.deliveryRetryAfter.set(run.id,Date.now() + 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('AutomationScheduler worker failed unexpectedly', {
        automationId: automation.id,
        runId: run.id,
        error: message,
      });
      try {
        const failed = await markRunFailed(run.id, {
          step: 'create_session',
          code: 'unknown',
          message,
        });
        this.callbacks.onRunStep(failed);
      } catch (markError) {
        log.error('AutomationScheduler failed to mark worker failed', {
          automationId: automation.id,
          runId: run.id,
          error: markError instanceof Error ? markError.message : String(markError),
        });
      }
    } finally {
      // #7221 一次性的那一刻过了、这一次也走完了:关掉。手动「立即运行」在那一刻之前跑完不算(还没到点);
      // 在那一刻之后跑完、而到点那次被它挤掉(previous_running)时,也在这里收口。
      if (automation.triggerConfig?.at != null) await this.closeSpentOneTime(automation.id);
      if (
        run.triggerKind === 'cron' &&
        automation.enabled &&
        !this.deletingAutomationIds.has(automation.id)
      ) {
        try {
          await ensureNextCronRun(automation, Date.now());
          this.callbacks.onScheduledRunChanged(automation.id);
        } catch (scheduleError) {
          log.error('AutomationScheduler failed to schedule next cron run', {
            automationId: automation.id,
            error: String(scheduleError),
          });
        }
      }
      this.inFlight.delete(automation.id);
    }
  }
}
