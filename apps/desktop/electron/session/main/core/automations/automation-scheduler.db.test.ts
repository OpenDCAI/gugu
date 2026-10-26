import { ok } from '@gugu/session-shared';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import { AutomationScheduler, type SchedulerCallbacks } from './automation-scheduler';
import { insertRun, setAutomationEnabled, skipQueuedCronRuns, softDeleteAutomation } from './repo';
import { setSessionAdmissionPreparation } from '../sessions/session-admission-preparation';
import { markRunDone } from './run-transitions';
import type { AutomationRunExecutor } from './runtime';

// Stop client.ts from opening the real Electron DB at import time.
// All domain code (repo, run-transitions) will read this getter and get the fixture DB.
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('./runtime', () => ({ runQueuedAutomation: vi.fn() }));

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

const TRIGGER_CONFIG = JSON.stringify({ expr: '0 9 * * *', tz: 'UTC' });
const SESSION_CONFIG = JSON.stringify({
  prompt: 'Check things',
  provider: 'claude',
  autoApprove: true,
});

function seedProject(fixture: Awaited<ReturnType<typeof openFixture>>, id = 'project-1'): void {
  fixture.sqlite
    .prepare(
      `INSERT INTO projects (id, name, path, created_at, updated_at)
       VALUES (?, 'Test Project', '/repo', 0, 0)`
    )
    .run(id);
}

function seedAutomation(
  fixture: Awaited<ReturnType<typeof openFixture>>,
  opts: {
    id?: string;
    projectId?: string | null;
    enabled?: number;
    triggerConfig?: string;
  } = {}
): string {
  const id = opts.id ?? 'automation-1';
  const projectId = opts.projectId === undefined ? 'project-1' : opts.projectId;
  const enabled = opts.enabled ?? 1;
  const triggerConfig = opts.triggerConfig ?? TRIGGER_CONFIG;

  fixture.sqlite
    .prepare(
      `INSERT INTO automations (id, name, project_id, trigger_config, agent_config, enabled, created_at, updated_at)
       VALUES (?, 'Daily follow-up', ?, ?, ?, ?, 0, 0)`
    )
    .run(id, projectId, triggerConfig, SESSION_CONFIG, enabled);

  return id;
}

function getRunRow(
  fixture: Awaited<ReturnType<typeof openFixture>>,
  id: string
): { status: string; error: string | null } | undefined {
  return fixture.sqlite
    .prepare('SELECT status, error FROM automation_runs WHERE id = ?')
    .get(id) as { status: string; error: string | null } | undefined;
}

/** 这次运行建出来的那条会话(会话行带着 automation_run_id)。 */
function seedAutomationSession(
  fixture: Awaited<ReturnType<typeof openFixture>>,
  runId: string,
  id = `session-${runId}`
): void {
  fixture.sqlite
    .prepare(
      `INSERT INTO sessions (id, project_id, title, automation_run_id)
       VALUES (?, 'project-1', 'Automation session', ?)`
    )
    .run(id, runId);
}

type InsertRunArgs = Parameters<typeof insertRun>[0];

async function insertTestRun(
  automationId: string,
  overrides: Partial<InsertRunArgs> = {}
): ReturnType<typeof insertRun> {
  return insertRun({
    automationId,
    triggerConfigSnapshot: { expr: '0 9 * * *', tz: 'UTC' },
    agentConfigSnapshot: {
      prompt: 'Check things',
      provider: 'claude',
      autoApprove: true,
    },
    status: 'queued',
    triggerKind: 'cron',
    ...overrides,
  } as InsertRunArgs);
}

function countRunsByStatus(
  fixture: Awaited<ReturnType<typeof openFixture>>,
  status: string,
  automationId?: string
): number {
  if (automationId) {
    return (
      fixture.sqlite
        .prepare('SELECT COUNT(*) as n FROM automation_runs WHERE status = ? AND automation_id = ?')
        .get(status, automationId) as { n: number }
    ).n;
  }
  return (
    fixture.sqlite
      .prepare('SELECT COUNT(*) as n FROM automation_runs WHERE status = ?')
      .get(status) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// Fake executor helpers
// ---------------------------------------------------------------------------

/** Executor that immediately marks the run done and notifies onStepCompleted. */
const doneExecutor: AutomationRunExecutor = async (_automation, run, onStepCompleted) => {
  const done = await markRunDone(run.id, Date.now());
  onStepCompleted(done);
  return ok(done);
};

/** Executor that holds until the returned release() is called, then marks done. */
function makeHeldExecutor(): { executor: AutomationRunExecutor; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor: AutomationRunExecutor = async (_automation, run, onStepCompleted) => {
    await gate;
    const done = await markRunDone(run.id, Date.now());
    onStepCompleted(done);
    return ok(done);
  };
  return { executor, release };
}

/** Executor that always throws. */
const throwingExecutor: AutomationRunExecutor = async () => {
  throw new Error('boom');
};

function makeCallbacks(onRunStep?: SchedulerCallbacks['onRunStep']): SchedulerCallbacks {
  return { onRunStep: onRunStep ?? (() => {}), onScheduledRunChanged: () => {} };
}

/**
 * 调度器每推进一步都回调(run 落库之后调 onRunStep,排好下一次 cron 之后调 onScheduledRunChanged)。
 * 用例等这些回调,❌ 轮询库:`when(条件)` 在某次回调之后条件成立时 resolve(已经成立就立刻 resolve)。
 * 用例自己的 executor 被调到也算一步,调 `notify()`。
 */
function recordingCallbacks() {
  const steps: AutomationRun[] = [];
  const scheduledChanges: string[] = [];
  const waiters = new Set<{ holds: () => boolean; resolve: () => void }>();
  const notify = (): void => {
    for (const waiter of waiters) {
      if (!waiter.holds()) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  };
  const callbacks: SchedulerCallbacks = {
    onRunStep: (run) => {
      steps.push(run);
      notify();
    },
    onScheduledRunChanged: (automationId) => {
      scheduledChanges.push(automationId);
      notify();
    },
  };
  const when = (holds: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      if (holds()) resolve();
      else waiters.add({ holds, resolve });
    });
  const reached = (runId: string, status: AutomationRun['status']): Promise<void> =>
    when(() => steps.some((run) => run.id === runId && run.status === status));
  return { callbacks, steps, scheduledChanges, when, reached, notify };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let fixture: Awaited<ReturnType<typeof openFixture>>;

beforeEach(async () => {
  setSessionAdmissionPreparation(null);
  vi.useFakeTimers();
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
});

afterEach(() => {
  setSessionAdmissionPreparation(null);
  fixture.close();
  mocks.db = undefined;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Recovery on startup
// ---------------------------------------------------------------------------

describe('AutomationScheduler recovery', () => {
  it.each([
    ['creating_session', false],
    ['launching_session', true],
    ['starting_agent', true],
  ] as const)('marks %s runs as failed with interrupted_by_restart', async (status, hasSession) => {
    seedProject(fixture);
    const automationId = seedAutomation(fixture);
    const run = await insertTestRun(automationId, { status, startedAt: Date.now() });
    if (hasSession) seedAutomationSession(fixture, run.id);

    const record = recordingCallbacks();
    const scheduler = new AutomationScheduler(record.callbacks, doneExecutor);
    scheduler.start();
    await record.reached(run.id, 'failed');
    scheduler.stop();

    expect(getRunRow(fixture, run.id)?.status).toBe('failed');

    expect(getRunRow(fixture, run.id)?.error).toContain('interrupted_by_restart');
  });

  it('leaves healthy queued runs untouched during recovery', async () => {
    seedProject(fixture);
    const automationId = seedAutomation(fixture);

    // Seed a queued run that should not be touched by recovery
    const run = await insertTestRun(automationId);
    // …and one stuck in the last stage recovery sweeps: failing it is recovery's final step, so once it is
    // failed, recovery has finished — only then does "the healthy run was not failed" mean anything.
    seedAutomation(fixture, { id: 'automation-stuck' });
    const stuck = await insertTestRun('automation-stuck', { status: 'starting_agent', startedAt: Date.now() });
    seedAutomationSession(fixture, stuck.id);

    // Use a held executor so the drain doesn't immediately consume it — we only care about recovery
    const { executor, release } = makeHeldExecutor();
    const record = recordingCallbacks();
    const scheduler = new AutomationScheduler(record.callbacks, executor);
    scheduler.start();

    await record.reached(stuck.id, 'failed');
    // Status should be queued or creating_session (drain may have claimed it), never failed
    expect(getRunRow(fixture, run.id)?.status).not.toBe('failed');
    expect(record.steps.filter((step) => step.status === 'failed').map((step) => step.id)).toEqual([stuck.id]);

    release();
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Bootstrap self-healing
// ---------------------------------------------------------------------------

describe('AutomationScheduler bootstrap self-healing', () => {
  it('schedules a cron run for an enabled automation that has none', async () => {
    const now = Date.UTC(2026, 4, 15, 12, 0, 0); // 2026-05-15 12:00 UTC
    vi.setSystemTime(now);

    seedProject(fixture);
    seedAutomation(fixture); // enabled, no runs yet

    const scheduler = new AutomationScheduler(makeCallbacks(), doneExecutor);
    await scheduler.reload();

    expect(countRunsByStatus(fixture, 'scheduled', 'automation-1')).toBe(1);
  });

  it('is idempotent — calling reload() twice creates no duplicates', async () => {
    const now = Date.UTC(2026, 4, 15, 12, 0, 0);
    vi.setSystemTime(now);

    seedProject(fixture);
    seedAutomation(fixture);

    const scheduler = new AutomationScheduler(makeCallbacks(), doneExecutor);
    await scheduler.reload();
    await scheduler.reload();

    expect(countRunsByStatus(fixture, 'scheduled', 'automation-1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Due cron transition
// ---------------------------------------------------------------------------

describe('AutomationScheduler due cron transition', () => {
  it('transitions a past-due scheduled run to queued and pre-schedules the next occurrence', async () => {
    const now = Date.UTC(2026, 4, 15, 12, 0, 0);
    vi.setSystemTime(now);

    seedProject(fixture);
    const automationId = seedAutomation(fixture);

    // Scheduled run that is already past due
    await insertTestRun(automationId, {
      scheduledAt: Date.UTC(2026, 4, 15, 9, 0, 0), // 9 AM, before our "now" of 12 PM
      deadlineAt: Date.UTC(2026, 4, 16, 9, 0, 0),
      status: 'scheduled',
    });

    const { executor, release } = makeHeldExecutor();
    const scheduler = new AutomationScheduler(makeCallbacks(), executor);
    await scheduler.reload();
    release();

    // The due run should have become queued (or been drained to creating_session)
    const rows = fixture.sqlite
      .prepare('SELECT status FROM automation_runs WHERE automation_id = ? AND scheduled_at = ?')
      .all(automationId, Date.UTC(2026, 4, 15, 9, 0, 0)) as { status: string }[];
    expect(['queued', 'creating_session', 'done']).toContain(rows[0]?.status);

    // A next occurrence should have been pre-scheduled
    const nextRows = fixture.sqlite
      .prepare(
        "SELECT status FROM automation_runs WHERE automation_id = ? AND scheduled_at > ? AND status = 'scheduled'"
      )
      .all(automationId, Date.UTC(2026, 4, 15, 9, 0, 0)) as { status: string }[];
    expect(nextRows.length).toBeGreaterThanOrEqual(1);
  });

  it('leaves a future-dated scheduled run in scheduled state', async () => {
    const now = Date.UTC(2026, 4, 15, 8, 0, 0); // before 9 AM
    vi.setSystemTime(now);

    seedProject(fixture);
    const automationId = seedAutomation(fixture);

    await insertTestRun(automationId, {
      scheduledAt: Date.UTC(2026, 4, 15, 9, 0, 0), // 9 AM — still in the future
      deadlineAt: Date.UTC(2026, 4, 16, 9, 0, 0),
      status: 'scheduled',
    });

    const scheduler = new AutomationScheduler(makeCallbacks(), doneExecutor);
    await scheduler.reload();

    expect(countRunsByStatus(fixture, 'scheduled', automationId)).toBe(1);
    expect(countRunsByStatus(fixture, 'queued', automationId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Drain queue decisions
// ---------------------------------------------------------------------------

describe('AutomationScheduler drain queue decisions', () => {
  it('skips a run whose deadline has already passed', async () => {
    const now = Date.UTC(2026, 4, 15, 12, 0, 0);
    vi.setSystemTime(now);

    seedProject(fixture);
    const automationId = seedAutomation(fixture);

    const run = await insertTestRun(automationId, {
      scheduledAt: Date.UTC(2026, 4, 15, 9, 0, 0),
      deadlineAt: Date.UTC(2026, 4, 15, 10, 0, 0), // already past
    });

    const scheduler = new AutomationScheduler(makeCallbacks(), async (_a, r, onStep) => {
      const done = await markRunDone(r.id, Date.now());
      onStep(done);
      return ok(done);
    });
    await scheduler.drainQueue();

    const row = getRunRow(fixture, run.id);
    expect(row?.status).toBe('skipped');
    expect(row?.error).toContain('deadline_exceeded');
  });

  it('skips a run for an automation with no project', async () => {
    seedProject(fixture);
    seedAutomation(fixture, { id: 'automation-orphan', projectId: null });

    const run = await insertTestRun('automation-orphan', { triggerKind: 'manual' });

    const scheduler = new AutomationScheduler(makeCallbacks(), async (_a, r, onStep) => {
      const done = await markRunDone(r.id, Date.now());
      onStep(done);
      return ok(done);
    });
    await scheduler.drainQueue();

    const row = getRunRow(fixture, run.id);
    expect(row?.status).toBe('skipped');
    expect(row?.error).toContain('no_project');
  });

  it('skips the second run when the same automation is already in flight', async () => {
    seedProject(fixture);
    const automationId = seedAutomation(fixture);

    const run1 = await insertTestRun(automationId, {
      scheduledAt: Date.UTC(2026, 4, 15, 9, 0, 0),
    });
    const run2 = await insertTestRun(automationId, {
      scheduledAt: Date.UTC(2026, 4, 15, 10, 0, 0),
    });

    const { executor, release } = makeHeldExecutor();
    const record = recordingCallbacks();
    const scheduler = new AutomationScheduler(record.callbacks, executor);
    await scheduler.drainQueue();

    // First run should be in flight (creating_session)
    expect(getRunRow(fixture, run1.id)?.status).toBe('creating_session');
    // Second run for the same automation should be skipped
    expect(getRunRow(fixture, run2.id)?.status).toBe('skipped');
    expect(getRunRow(fixture, run2.id)?.error).toContain('previous_running');

    release();
    await record.reached(run1.id, 'done');
    expect(getRunRow(fixture, run1.id)?.status).toBe('done');
  });

  it('does not re-claim a run that is already past queued (CAS guard)', async () => {
    seedProject(fixture);
    const automationId = seedAutomation(fixture);

    // Seed a run already in creating_session — the CAS in startCreatingSession should skip it
    const run = await insertTestRun(automationId, {
      status: 'creating_session',
      startedAt: Date.now(),
    });

    const scheduler = new AutomationScheduler(makeCallbacks(), async (_a, r, onStep) => {
      const done = await markRunDone(r.id, Date.now());
      onStep(done);
      return ok(done);
    });
    await scheduler.drainQueue();

    // Status should remain creating_session (was not touched by drain)
    expect(getRunRow(fixture, run.id)?.status).toBe('creating_session');
  });
});

// ---------------------------------------------------------------------------
// Concurrency (slot pool) on real DB
// ---------------------------------------------------------------------------

describe('AutomationScheduler concurrency', () => {
  it('runs at most 4 automation workers concurrently', async () => {
    seedProject(fixture);

    const releaseMap = new Map<string, () => void>();
    const executorCalls: string[] = [];

    for (let i = 0; i < 6; i++) {
      const autoId = `auto-${i}`;
      seedAutomation(fixture, { id: autoId });
      await insertTestRun(autoId, {
        scheduledAt: Date.UTC(2026, 4, 15, 9, i, 0),
      });
    }

    const record = recordingCallbacks();
    const executor: AutomationRunExecutor = async (_automation, run, onStepCompleted) => {
      const gate = new Promise<void>((resolve) => releaseMap.set(run.id, resolve));
      executorCalls.push(run.id);
      record.notify();
      await gate;
      const done = await markRunDone(run.id, Date.now());
      onStepCompleted(done);
      return ok(done);
    };

    const scheduler = new AutomationScheduler(record.callbacks, executor);
    await scheduler.drainQueue();

    expect(countRunsByStatus(fixture, 'creating_session')).toBe(4);
    expect(countRunsByStatus(fixture, 'queued')).toBe(2);
    expect(executorCalls).toHaveLength(4);

    releaseMap.get(executorCalls[0]!)?.();
    await record.when(() => executorCalls.length === 5);
    expect(countRunsByStatus(fixture, 'creating_session')).toBe(4);

    for (const runId of executorCalls.slice(1)) {
      releaseMap.get(runId)?.();
    }
    await record.when(() => executorCalls.length === 6);
    releaseMap.get(executorCalls[5]!)?.();
    await record.when(() => record.steps.filter((step) => step.status === 'done').length === 6);
    expect(countRunsByStatus(fixture, 'done')).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Post-worker rescheduling
// ---------------------------------------------------------------------------

describe('AutomationScheduler post-worker rescheduling', () => {
  it('schedules the next cron occurrence after a cron worker completes', async () => {
    const now = Date.UTC(2026, 4, 15, 9, 0, 0);
    vi.setSystemTime(now);

    seedProject(fixture);
    const automationId = seedAutomation(fixture);

    const run = await insertTestRun(automationId, { scheduledAt: now });

    const record = recordingCallbacks();
    const scheduler = new AutomationScheduler(record.callbacks, doneExecutor);
    await scheduler.drainQueue();

    await record.reached(run.id, 'done');
    expect(getRunRow(fixture, run.id)?.status).toBe('done');

    // A subsequent scheduled run is created after the worker settles.
    await record.when(() => record.scheduledChanges.includes(automationId));
    const nextRows = fixture.sqlite
      .prepare(
        "SELECT status FROM automation_runs WHERE automation_id = ? AND id != ? AND status = 'scheduled'"
      )
      .all(automationId, run.id) as { status: string }[];
    expect(nextRows.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Worker error handling
// ---------------------------------------------------------------------------

describe('AutomationScheduler worker error handling', () => {
  it('marks the run failed when the executor throws unexpectedly', async () => {
    seedProject(fixture);
    const automationId = seedAutomation(fixture);

    const run = await insertTestRun(automationId, { triggerKind: 'manual' });

    const record = recordingCallbacks();
    const scheduler = new AutomationScheduler(record.callbacks, throwingExecutor);
    await scheduler.drainQueue();

    await record.reached(run.id, 'failed');
    const row = getRunRow(fixture, run.id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('boom');
  });
});


describe('assistant panel changes before schedule execution', () => {
  function assistantSchedule(id: string, sessionId: string) {
    seedAutomation(fixture,{ id });
    fixture.sqlite.prepare('UPDATE automations SET agent_session_id = ? WHERE id = ?').run(sessionId,id);
  }

  it('applies a saved deletion before taking scheduler locks or starting a queued run', async () => {
    seedProject(fixture);
    assistantSchedule('removed','assistant-session');
    const run = await insertTestRun('removed');
    const executor = vi.fn(doneExecutor);
    const scheduler = new AutomationScheduler(makeCallbacks(),executor);
    setSessionAdmissionPreparation(async (sessionId,text) => {
      expect(sessionId).toBe('assistant-session');
      expect(await scheduler.beginAutomationDeletion('removed')).toBe(true);
      await skipQueuedCronRuns('removed','automation_deleted');
      await softDeleteAutomation('removed');
      scheduler.endAutomationDeletion('removed');
      return { text,assistantPanel: true,accepted: async () => {} };
    });
    await scheduler.drainQueue();
    expect(executor).not.toHaveBeenCalled();
    expect(getRunRow(fixture,run.id)?.status).toBe('skipped');
  });

  it('applies a saved disable before claiming queued work', async () => {
    seedProject(fixture);
    assistantSchedule('disabled','assistant-session');
    const run = await insertTestRun('disabled');
    const executor = vi.fn(doneExecutor);
    setSessionAdmissionPreparation(async (_sessionId,text) => {
      await setAutomationEnabled('disabled',false);
      await skipQueuedCronRuns('disabled','disabled');
      return { text,assistantPanel: true,accepted: async () => {} };
    });
    await new AutomationScheduler(makeCallbacks(),executor).drainQueue();
    expect(executor).not.toHaveBeenCalled();
    expect(getRunRow(fixture,run.id)?.status).toBe('skipped');
  });

  it('records the exact unapplied item and still executes an unrelated schedule', async () => {
    seedProject(fixture);
    assistantSchedule('blocked','assistant-session');
    seedAutomation(fixture,{ id: 'ordinary' });
    const blocked = await insertTestRun('blocked');
    const ordinary = await insertTestRun('ordinary');
    const completed = Promise.withResolvers<void>();
    const executor: AutomationRunExecutor = async (automation,run,onStep) => {
      expect(automation.id).toBe('ordinary');
      const result = await doneExecutor(automation,run,onStep); completed.resolve(); return result;
    };
    setSessionAdmissionPreparation(async () => { throw new Error('memory/deleted-note: LOCAL_DELETE_DENIED'); });
    await new AutomationScheduler(makeCallbacks(),executor).drainQueue();
    await completed.promise;
    expect(getRunRow(fixture,blocked.id)).toMatchObject({ status: 'failed' });
    expect(getRunRow(fixture,blocked.id)?.error).toContain('memory/deleted-note: LOCAL_DELETE_DENIED');
    expect(getRunRow(fixture,ordinary.id)?.status).toBe('done');
  });
});
