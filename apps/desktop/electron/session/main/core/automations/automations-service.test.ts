import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveSession } from '@main/core/sessions/archiveSession';
import type { Automation } from '@shared/core/automations/automation';
import { AutomationsService } from './automations-service';
import {
  getAutomation,
  listAutomationRunCleanupTargets,
  removeRun,
  skipQueuedCronRuns,
  softDeleteAutomation,
} from './repo';

const mocks = vi.hoisted(() => ({
  schedulerReload: vi.fn(),
  beginAutomationDeletion: vi.fn(),
  endAutomationDeletion: vi.fn(),
  archiveSession: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@main/core/sessions/archiveSession', () => ({
  archiveSession: mocks.archiveSession,
}));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('@main/lib/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('./automation-scheduler', () => ({
  AutomationScheduler: class {
    start() {}
    stop() {}
    reload = mocks.schedulerReload;
    beginAutomationDeletion = mocks.beginAutomationDeletion;
    endAutomationDeletion = mocks.endAutomationDeletion;
    executeNow() {}
  },
}));
vi.mock('./repo', () => ({
  createAutomation: vi.fn(),
  ensureNextCronRun: vi.fn(),
  getAutomation: vi.fn(),
  getRun: vi.fn(),
  insertRun: vi.fn(),
  listAutomationRunCleanupTargets: vi.fn(),
  listAutomations: vi.fn(),
  removeRun: vi.fn(),
  renameAutomation: vi.fn(),
  setAutomationEnabled: vi.fn(),
  skipQueuedCronRuns: vi.fn(),
  softDeleteAutomation: vi.fn(),
  updateAutomationSettings: vi.fn(),
}));
vi.mock('./run-transitions', () => ({ markRunSkipped: vi.fn() }));

const automation: Automation = {
  id: 'automation-1',
  name: 'Daily cleanup',
  projectId: 'project-1',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

describe('AutomationsService.deleteAutomation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAutomation).mockResolvedValue(automation);
    vi.mocked(skipQueuedCronRuns).mockResolvedValue([]);
    vi.mocked(listAutomationRunCleanupTargets).mockResolvedValue([]);
    vi.mocked(removeRun).mockResolvedValue(true);
    vi.mocked(softDeleteAutomation).mockResolvedValue(true);
    mocks.beginAutomationDeletion.mockResolvedValue(true);
  });

  it('deletes terminal run sessions before their run rows and the automation', async () => {
    vi.mocked(listAutomationRunCleanupTargets).mockResolvedValue([
      { runId: 'run-1', status: 'done', sessionId: 'session-1', projectId: 'project-1' },
      { runId: 'run-2', status: 'failed', sessionId: 'session-2', projectId: 'project-1' },
      { runId: 'run-3', status: 'skipped', sessionId: null, projectId: null },
    ]);

    await new AutomationsService().deleteAutomation(automation.id);

    expect(archiveSession).toHaveBeenNthCalledWith(1, 'project-1', 'session-1');
    expect(archiveSession).toHaveBeenNthCalledWith(2, 'project-1', 'session-2');
    expect(removeRun).toHaveBeenNthCalledWith(1, 'run-1');
    expect(removeRun).toHaveBeenNthCalledWith(2, 'run-2');
    expect(removeRun).toHaveBeenNthCalledWith(3, 'run-3');
    expect(softDeleteAutomation).toHaveBeenCalledWith(automation.id);
    expect(mocks.archiveSession.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(removeRun).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(removeRun).mock.invocationCallOrder[2]).toBeLessThan(
      vi.mocked(softDeleteAutomation).mock.invocationCallOrder[0]
    );
  });

  it('rejects active runs without hiding the automation', async () => {
    vi.mocked(listAutomationRunCleanupTargets).mockResolvedValue([
      {
        runId: 'run-active',
        status: 'starting_agent',
        sessionId: 'session-active',
        projectId: 'project-1',
      },
    ]);

    await expect(new AutomationsService().deleteAutomation(automation.id)).rejects.toThrow(
      'automation_runs_active'
    );

    expect(skipQueuedCronRuns).toHaveBeenCalledWith(automation.id, 'automation_deleted');
    expect(archiveSession).not.toHaveBeenCalled();
    expect(removeRun).not.toHaveBeenCalled();
    expect(softDeleteAutomation).not.toHaveBeenCalled();
  });

  it('rejects a scheduler-owned worker before mutating run state', async () => {
    mocks.beginAutomationDeletion.mockResolvedValue(false);

    await expect(new AutomationsService().deleteAutomation(automation.id)).rejects.toThrow(
      'automation_runs_active'
    );

    expect(skipQueuedCronRuns).not.toHaveBeenCalled();
    expect(listAutomationRunCleanupTargets).not.toHaveBeenCalled();
    expect(softDeleteAutomation).not.toHaveBeenCalled();
    expect(mocks.endAutomationDeletion).toHaveBeenCalledWith(automation.id);
  });

  it('keeps the automation visible when a run row cannot be removed', async () => {
    vi.mocked(listAutomationRunCleanupTargets).mockResolvedValue([
      { runId: 'run-1', status: 'done', sessionId: null, projectId: null },
    ]);
    vi.mocked(removeRun).mockResolvedValue(false);

    await expect(new AutomationsService().deleteAutomation(automation.id)).rejects.toThrow(
      'automation_run_cleanup_failed'
    );

    expect(softDeleteAutomation).not.toHaveBeenCalled();
  });
});
