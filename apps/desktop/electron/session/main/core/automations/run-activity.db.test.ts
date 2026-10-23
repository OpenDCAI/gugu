import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { onActivitySignal } from '../activity/signals';
import {
  insertRun,
  markDueCronRunsQueued,
  scheduleAutomationRun,
  skipQueuedCronRuns,
  startCreatingSession,
  updateRun,
} from './repo';
import { markRunDone } from './run-transitions';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const TRIGGER = { expr: '0 9 * * *', tz: 'UTC' };
const AGENT = { prompt: 'Check things', provider: 'claude', autoApprove: true };
let fixture: Awaited<ReturnType<typeof openFixture>>;
let signalled: string[];
let stopListening: () => void;

/** Every status the database wrote to automation_runs, by a trigger that sees every write path. */
function written(): string[] {
  return (fixture.sqlite.prepare('SELECT run_id, status FROM run_writes ORDER BY rowid').all() as Array<{ run_id: string; status: string }>)
    .map((row) => `${row.run_id}:${row.status}`);
}

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  fixture.sqlite.exec(`
    INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('project-1', 'P', '/repo', 0, 0);
    INSERT INTO automations (id, name, project_id, trigger_config, agent_config, enabled, created_at, updated_at)
      VALUES ('automation-1', 'Daily', 'project-1', '${JSON.stringify(TRIGGER)}', '${JSON.stringify(AGENT)}', 1, 0, 0);
    CREATE TEMP TABLE run_writes (run_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TEMP TRIGGER run_inserted AFTER INSERT ON automation_runs BEGIN
      INSERT INTO run_writes VALUES (NEW.id, NEW.status);
    END;
    CREATE TEMP TRIGGER run_updated AFTER UPDATE ON automation_runs BEGIN
      INSERT INTO run_writes VALUES (NEW.id, NEW.status);
    END;
  `);
  signalled = [];
  stopListening = onActivitySignal((event) => {
    if (event.kind === 'automation.run') signalled.push(`${event.object_id}:${event.status}`);
  });
});
afterEach(() => {
  stopListening?.();
  fixture?.close();
  mocks.db = undefined;
});

describe('automation run status writes reach the activity journal', () => {
  it('signals exactly the statuses the database wrote, on every write path', async () => {
    const snapshot = { automationId: 'automation-1', triggerConfigSnapshot: TRIGGER, agentConfigSnapshot: AGENT,
      sessionConfigSnapshot: null, triggerKind: 'cron' as const };
    const due = await scheduleAutomationRun({ ...snapshot, scheduledAt: 1_000, deadlineAt: null });
    const later = await scheduleAutomationRun({ ...snapshot, scheduledAt: 9_000_000_000_000, deadlineAt: null });
    expect(due?.status).toBe('scheduled');

    const queued = await markDueCronRunsQueued(2_000);
    expect(queued.map(({ run }) => [run.id, run.status])).toEqual([[due!.id, 'queued']]);
    const started = await startCreatingSession(due!.id, 3_000);
    expect(started?.status).toBe('creating_session');
    await updateRun(due!.id, { status: 'launching_session', launchedAt: 4_000 });
    await markRunDone(due!.id, 5_000);

    const manual = await insertRun({ automationId: 'automation-1', triggerConfigSnapshot: TRIGGER,
      agentConfigSnapshot: AGENT, status: 'queued', triggerKind: 'manual' });
    // Disabling the schedule skips the cron run that was still waiting.
    const skipped = await skipQueuedCronRuns('automation-1', 'disabled');
    expect(skipped.map((run) => [run.id, run.status])).toEqual([[later!.id, 'skipped']]);

    expect(written()).toContain(`${later!.id}:skipped`);
    expect(written()).toContain(`${manual.id}:queued`);
    expect(signalled).toEqual(written());
  });

  it('a write that changed nothing signals nothing', async () => {
    expect(await startCreatingSession('missing-run', 1_000)).toBeNull();
    expect(await skipQueuedCronRuns('automation-1', 'disabled')).toEqual([]);
    expect(written()).toEqual([]);
    expect(signalled).toEqual([]);
  });
});
