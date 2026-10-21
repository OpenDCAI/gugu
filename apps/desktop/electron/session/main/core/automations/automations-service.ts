import { and, asc, count, desc, eq, ne, sql } from 'drizzle-orm';
import { deleteSession } from '@main/core/sessions/deleteSession';
import { db } from '@main/db/client';
import { automationRuns, sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import type {
  Automation,
  CreateAutomationParams,
  UpdateAutomationSettingsPatch,
} from '@shared/core/automations/automation';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import {
  automationChangedChannel,
  automationRunChangedChannel,
} from '@shared/core/automations/automationEvents';
import { AutomationScheduler } from './automation-scheduler';
import {
  createAgentSchedule as repoCreateAgentSchedule,
  createAutomation as repoCreateAutomation,
  ensureNextCronRun,
  getAutomation,
  getRun,
  insertRun,
  listAutomationRunCleanupTargets,
  listAutomations as repoListAutomations,
  removeRun,
  renameAutomation as renameInRepo,
  setAutomationEnabled as repoSetAutomationEnabled,
  skipQueuedCronRuns,
  softDeleteAutomation,
  updateAutomationSettings as updateSettingsInRepo,
} from './repo';
import { markRunSkipped } from './run-transitions';
import { mapAutomationRunRowToAutomationRun } from './utils';

export type AutomationsServiceHooks = {
  'automation:created': (automation: Automation) => void | Promise<void>;
  'automation:updated': (automation: Automation) => void | Promise<void>;
  'automation:enabled': (automation: Automation) => void | Promise<void>;
  'run:started': (run: AutomationRun) => void | Promise<void>;
  'run:stopped': (run: AutomationRun) => void | Promise<void>;
  'run:step-completed': (run: AutomationRun) => void | Promise<void>;
};

export class AutomationsService implements Hookable<AutomationsServiceHooks> {
  private readonly _hooks = new HookCore<AutomationsServiceHooks>((name, e) =>
    log.error(`AutomationsService: ${String(name)} hook error`, e)
  );
  private readonly deletingAutomationIds = new Set<string>();
  private readonly startingAutomationCounts = new Map<string, number>();

  private readonly scheduler = new AutomationScheduler({
    onRunStep: (run) => {
      this._hooks.callHookBackground('run:step-completed', run);
      events.emit(automationRunChangedChannel, { automationId: run.automationId, run });
    },
    onScheduledRunChanged: (automationId) => {
      events.emit(automationChangedChannel, { automationId });
    },
  });

  on<K extends keyof AutomationsServiceHooks>(name: K, handler: AutomationsServiceHooks[K]) {
    return this._hooks.on(name, handler);
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  notifyRunStep(run: AutomationRun): void {
    this._hooks.callHookBackground('run:step-completed', run);
  }

  async listAutomations(projectId?: string): Promise<Automation[]> {
    return repoListAutomations(projectId);
  }

  async createAutomation(params: CreateAutomationParams): Promise<Automation> {
    const automation = await repoCreateAutomation(params);
    this._hooks.callHookBackground('automation:created', automation);
    events.emit(automationChangedChannel, { automationId: automation.id });
    void this.scheduler.reload();
    return automation;
  }

  /** #7221 agent 给自己排的一条(见 agent-schedules.ts);建好时下一次运行已经预排上了,与人建的一样进列表。 */
  async createAgentSchedule(
    input: Parameters<typeof repoCreateAgentSchedule>[0]
  ): Promise<{ automation: Automation; nextRun: AutomationRun | null }> {
    const created = await repoCreateAgentSchedule(input);
    this._hooks.callHookBackground('automation:created', created.automation);
    events.emit(automationChangedChannel, { automationId: created.automation.id });
    return created;
  }

  async updateAutomationSettings(
    id: string,
    patch: UpdateAutomationSettingsPatch
  ): Promise<Automation> {
    const automation = await updateSettingsInRepo(id, patch);
    if (!automation) throw new Error('automation_not_found');
    if (patch.triggerConfig !== undefined) {
      await skipQueuedCronRuns(id, 'trigger_changed');
      if (automation.enabled) {
        await ensureNextCronRun(automation);
        events.emit(automationChangedChannel, { automationId: id });
      }
      void this.scheduler.reload();
    }
    this._hooks.callHookBackground('automation:updated', automation);
    events.emit(automationChangedChannel, { automationId: id });
    return automation;
  }

  async renameAutomation(id: string, name: string): Promise<Automation> {
    const automation = await renameInRepo(id, name);
    if (!automation) throw new Error('automation_not_found');
    this._hooks.callHookBackground('automation:updated', automation);
    events.emit(automationChangedChannel, { automationId: id });
    return automation;
  }

  async toggleAutomationEnabled(id: string, enabled: boolean): Promise<void> {
    return this.setAutomationEnabled(id, enabled);
  }

  async setAutomationEnabled(id: string, enabled: boolean): Promise<void> {
    const automation = await repoSetAutomationEnabled(id, enabled);
    if (!automation) throw new Error('automation_not_found');
    if (enabled) {
      await ensureNextCronRun(automation);
    } else {
      await skipQueuedCronRuns(id, 'disabled');
    }
    this._hooks.callHookBackground('automation:enabled', automation);
    events.emit(automationChangedChannel, { automationId: id });
    void this.scheduler.reload();
  }

  async listAutomationRuns(
    automationId: string,
    limit: number,
    offset: number,
    statusFilter?: 'done' | 'failed' | 'skipped'
  ): Promise<AutomationRun[]> {
    const rows = await db
      .select({ run: automationRuns, sessionId: sessions.id })
      .from(automationRuns)
      .leftJoin(sessions, eq(sessions.automationRunId, automationRuns.id))
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          ne(automationRuns.status, 'scheduled'),
          statusFilter ? eq(automationRuns.status, statusFilter) : undefined
        )
      )
      .orderBy(desc(automationRuns.startedAt))
      .limit(limit)
      .offset(offset);
    return rows.map(({ run, sessionId }) => mapAutomationRunRowToAutomationRun(run, sessionId));
  }

  async countAutomationRunsByStatus(
    automationId: string
  ): Promise<{ all: number; done: number; failed: number; skipped: number }> {
    const [result] = await db
      .select({
        all: count(),
        done: sql<number>`COUNT(CASE WHEN ${automationRuns.status} = 'done' THEN 1 END)`,
        failed: sql<number>`COUNT(CASE WHEN ${automationRuns.status} = 'failed' THEN 1 END)`,
        skipped: sql<number>`COUNT(CASE WHEN ${automationRuns.status} = 'skipped' THEN 1 END)`,
      })
      .from(automationRuns)
      .where(
        and(eq(automationRuns.automationId, automationId), ne(automationRuns.status, 'scheduled'))
      );
    return result ?? { all: 0, done: 0, failed: 0, skipped: 0 };
  }

  async getLatestRun(automationId: string): Promise<AutomationRun | null> {
    const rows = await db
      .select({ run: automationRuns, sessionId: sessions.id })
      .from(automationRuns)
      .leftJoin(sessions, eq(sessions.automationRunId, automationRuns.id))
      .where(
        and(eq(automationRuns.automationId, automationId), ne(automationRuns.status, 'scheduled'))
      )
      .orderBy(desc(automationRuns.startedAt))
      .limit(1);
    return rows[0] ? mapAutomationRunRowToAutomationRun(rows[0].run, rows[0].sessionId) : null;
  }

  async getNextScheduledRun(automationId: string): Promise<AutomationRun | null> {
    const rows = await db
      .select({ run: automationRuns, sessionId: sessions.id })
      .from(automationRuns)
      .leftJoin(sessions, eq(sessions.automationRunId, automationRuns.id))
      .where(
        and(eq(automationRuns.automationId, automationId), eq(automationRuns.status, 'scheduled'))
      )
      .orderBy(asc(automationRuns.scheduledAt))
      .limit(1);
    return rows[0] ? mapAutomationRunRowToAutomationRun(rows[0].run, rows[0].sessionId) : null;
  }

  async runAutomation(id: string): Promise<AutomationRun> {
    if (this.deletingAutomationIds.has(id)) throw new Error('automation_deletion_in_progress');
    this.startingAutomationCounts.set(id, (this.startingAutomationCounts.get(id) ?? 0) + 1);
    try {
      const automation = await getAutomation(id);
      if (!automation) throw new Error('automation_not_found');
      if (!automation.projectId && !automation.agentSessionId) throw new Error('no_project_attached');
      if (!automation.agentConfig || !automation.triggerConfig)
        throw new Error('automation_not_configured');

      const now = Date.now();
      const run = await insertRun({
        automationId: id,
        triggerConfigSnapshot: automation.triggerConfig,
        agentConfigSnapshot: automation.agentConfig,
        sessionConfigSnapshot: automation.sessionConfig ?? null,
        scheduledAt: now,
        deadlineAt: null,
        status: 'creating_session',
        triggerKind: 'manual',
        startedAt: now,
      });

      this.scheduler.executeNow(automation, run);

      this._hooks.callHookBackground('run:started', run);
      return run;
    } finally {
      const remainingStarts = (this.startingAutomationCounts.get(id) ?? 1) - 1;
      if (remainingStarts === 0) this.startingAutomationCounts.delete(id);
      else this.startingAutomationCounts.set(id, remainingStarts);
    }
  }

  async stopRun(runId: string): Promise<AutomationRun> {
    const run = await getRun(runId);
    if (!run) throw new Error('run_not_found');
    let stopped: AutomationRun;
    if (run.status === 'queued') {
      stopped = await markRunSkipped(runId, { step: 'queue', code: 'manually_stopped' });
    } else if (
      run.status === 'creating_session' ||
      run.status === 'launching_session' ||
      run.status === 'starting_agent'
    ) {
      // In-progress steps — mark as failed (PTY stop is handled by renderer via run.conversationId)
      stopped = await markRunSkipped(runId, { step: 'queue', code: 'manually_stopped' });
    } else {
      throw new Error('run_not_stoppable');
    }
    this._hooks.callHookBackground('run:stopped', stopped);
    this._hooks.callHookBackground('run:step-completed', stopped);
    return stopped;
  }

  async getRun(runId: string): Promise<AutomationRun | null> {
    return getRun(runId);
  }

  async deleteAutomation(id: string): Promise<void> {
    if (this.deletingAutomationIds.has(id)) throw new Error('automation_deletion_in_progress');
    this.deletingAutomationIds.add(id);
    try {
      const automation = await getAutomation(id);
      if (!automation) throw new Error('automation_not_found');
      if ((this.startingAutomationCounts.get(id) ?? 0) > 0) {
        throw new Error('automation_runs_active');
      }
      if (!(await this.scheduler.beginAutomationDeletion(id))) {
        throw new Error('automation_runs_active');
      }

      await skipQueuedCronRuns(id, 'automation_deleted');
      const targets = await listAutomationRunCleanupTargets(id);
      const hasActiveRun = targets.some(
        ({ status }) =>
          status === 'creating_session' ||
          status === 'launching_session' ||
          status === 'starting_agent'
      );
      if (hasActiveRun) throw new Error('automation_runs_active');

      // 还挂在运行上的会话随自动化一起删;被收成普通会话的已经不在这里(它的 automation_run_id 清掉了)。
      for (const target of targets) {
        if (target.sessionId === null || target.projectId === null) continue;
        await deleteSession(target.projectId, target.sessionId);
      }

      for (const runId of new Set(targets.map((target) => target.runId))) {
        if (!(await removeRun(runId))) throw new Error('automation_run_cleanup_failed');
      }

      const deleted = await softDeleteAutomation(id);
      if (!deleted) throw new Error('automation_cleanup_failed');
      events.emit(automationChangedChannel, { automationId: id });
      void this.scheduler.reload();
    } finally {
      this.scheduler.endAutomationDeletion(id);
      this.deletingAutomationIds.delete(id);
    }
  }
}

export const automationsService = new AutomationsService();
