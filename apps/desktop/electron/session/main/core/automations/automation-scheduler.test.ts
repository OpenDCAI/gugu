/**
 * Pure coordination tests for AutomationScheduler that do not need a real DB.
 * These cover the async-sequencing behavior of bootstrapTail and drainTail promise chains.
 *
 * DB-state tests (recovery, bootstrap self-healing, drain decisions, concurrency, events)
 * live in automation-scheduler.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@main/lib/logger';
import type { Automation } from '@shared/core/automations/automation';
import { AutomationScheduler, msUntilNextTick, type SchedulerCallbacks } from './automation-scheduler';
import {
  enabledAutomationsWithoutQueuedRun,
  ensureNextCronRun,
  findRunsStuckInStartingAgent,
  findRunsStuckInCreatingSession,
  findRunsStuckInLaunchingSession,
  getAutomation,
  listQueuedRuns,
  markDueCronRunsQueued,
  startCreatingSession,
  updateRun,
} from './repo';
import { runQueuedAutomation } from './runtime';

vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

vi.mock('./repo', () => ({
  enabledAutomationsWithoutQueuedRun: vi.fn(),
  ensureNextCronRun: vi.fn(),
  findRunsStuckInStartingAgent: vi.fn(),
  findRunsStuckInCreatingSession: vi.fn(),
  findRunsStuckInLaunchingSession: vi.fn(),
  getAutomation: vi.fn(),
  listQueuedRuns: vi.fn(),
  markDueCronRunsQueued: vi.fn(),
  startCreatingSession: vi.fn(),
  updateRun: vi.fn(),
}));

vi.mock('./runtime', () => ({
  runQueuedAutomation: vi.fn(),
}));

const noopCallbacks: SchedulerCallbacks = { onRunStep: () => {}, onScheduledRunChanged: () => {} };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(findRunsStuckInCreatingSession).mockResolvedValue([]);
  vi.mocked(findRunsStuckInLaunchingSession).mockResolvedValue([]);
  vi.mocked(findRunsStuckInStartingAgent).mockResolvedValue([]);
  vi.mocked(enabledAutomationsWithoutQueuedRun).mockResolvedValue([]);
  vi.mocked(getAutomation).mockResolvedValue(null);
  vi.mocked(markDueCronRunsQueued).mockResolvedValue([]);
  vi.mocked(listQueuedRuns).mockResolvedValue([]);
  vi.mocked(startCreatingSession).mockResolvedValue(null);
  vi.mocked(ensureNextCronRun).mockResolvedValue(null);
  vi.mocked(updateRun).mockResolvedValue(null);
  vi.mocked(runQueuedAutomation).mockResolvedValue({ success: true, data: {} as never });
});

describe('AutomationScheduler bootstrap serialization', () => {
  it('serializes overlapping reloads and re-runs bootstrap once', async () => {
    const firstBootstrap = Promise.withResolvers<Automation[]>();
    const bootstrapping = Promise.withResolvers<void>();
    vi.mocked(enabledAutomationsWithoutQueuedRun)
      .mockImplementationOnce(() => {
        bootstrapping.resolve();
        return firstBootstrap.promise;
      })
      .mockResolvedValue([]);

    const scheduler = new AutomationScheduler(noopCallbacks);
    const firstReload = scheduler.reload();
    const secondReload = scheduler.reload();

    await bootstrapping.promise;
    expect(enabledAutomationsWithoutQueuedRun).toHaveBeenCalledTimes(1);
    firstBootstrap.resolve([]);
    await Promise.all([firstReload, secondReload]);

    expect(enabledAutomationsWithoutQueuedRun).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['bootstrap', enabledAutomationsWithoutQueuedRun, (scheduler: AutomationScheduler) => scheduler.reload(), 'AutomationScheduler bootstrap failed'],
    ['queue drain', listQueuedRuns, (scheduler: AutomationScheduler) => scheduler.drainQueue(), 'AutomationScheduler queue drain failed'],
  ] as const)('swallows %s failures and does not reject callers', async (_label, query, run, message) => {
    vi.mocked(query).mockRejectedValueOnce(new Error('db failed'));

    await expect(run(new AutomationScheduler(noopCallbacks))).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(message, {
      error: 'Error: db failed',
    });
  });
});

describe('AutomationScheduler drain serialization', () => {
  it('does not start a queued run after deletion fences an active drain', async () => {
    const firstList = Promise.withResolvers<Awaited<ReturnType<typeof listQueuedRuns>>>();
    const listing = Promise.withResolvers<void>();
    const automationId = 'auto-delete';
    const queuedRun = {
      id: 'run-delete',
      automationId,
      scheduledAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
      startedAt: null,
      sessionCreatedAt: null,
      launchedAt: null,
      finishedAt: null,
      status: 'queued' as const,
      sessionId: null,
      error: null,
      triggerKind: 'cron' as const,
      triggerConfigSnapshot: { expr: '0 9 * * *', tz: 'UTC' },
      agentConfigSnapshot: {
        prompt: 'Check things',
        provider: 'claude',
        autoApprove: true,
      },
      sessionConfigSnapshot: null,
      generatedSessionName: null,
    };
    const automation: Automation = {
      id: automationId,
      name: 'Delete me',
      triggerConfig: queuedRun.triggerConfigSnapshot,
      agentConfig: queuedRun.agentConfigSnapshot,
      projectId: 'project-1',
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };
    vi.mocked(listQueuedRuns)
      .mockImplementationOnce(() => {
        listing.resolve();
        return firstList.promise;
      })
      .mockResolvedValue([]);
    vi.mocked(updateRun).mockResolvedValue({ ...queuedRun, status: 'skipped' });

    const scheduler = new AutomationScheduler(noopCallbacks);
    const drain = scheduler.drainQueue();
    await listing.promise;
    const fenced = scheduler.beginAutomationDeletion(automationId);
    firstList.resolve([{ run: queuedRun, automation }]);

    await expect(fenced).resolves.toBe(true);
    await drain;
    expect(startCreatingSession).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith(
      queuedRun.id,
      expect.objectContaining({ status: 'skipped' })
    );
  });

  it('reruns a drain pass requested while another drain is active', async () => {
    const firstList = Promise.withResolvers<Awaited<ReturnType<typeof listQueuedRuns>>>();
    const listing = Promise.withResolvers<void>();
    // 工作者跑完腾出名额 ⇒ 调度器自己再排一趟(第 4 次列队列):这一次就是要等的事实。
    const drainAfterSlotFreed = Promise.withResolvers<void>();
    let releaseWorker: (() => void) | undefined;

    const automationId = 'auto-rerun';
    const runId = 'run-rerun';
    const entry = {
      run: {
        id: runId,
        automationId,
        scheduledAt: Date.now(),
        deadlineAt: Date.now() + 60_000,
        startedAt: null,
        sessionCreatedAt: null,
        launchedAt: null,
        finishedAt: null,
        status: 'queued' as const,
        sessionId: null,
        error: null,
        triggerKind: 'cron' as const,
        triggerConfigSnapshot: { expr: '0 9 * * *', tz: 'UTC' },
        agentConfigSnapshot: {
          prompt: 'Check things',
          provider: 'claude',
          autoApprove: true,
        },
        sessionConfigSnapshot: null,
        generatedSessionName: null,
      },
      automation: {
        id: automationId,
        name: 'Test',
        triggerConfig: { expr: '0 9 * * *', tz: 'UTC' },
        agentConfig: { prompt: 'Check things', provider: 'claude', autoApprove: true },
        projectId: 'project-1',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
    };
    const creatingSessionRun = {
      ...entry.run,
      status: 'creating_session' as const,
      startedAt: Date.now(),
    };

    vi.mocked(listQueuedRuns)
      .mockImplementationOnce(() => {
        listing.resolve();
        return firstList.promise;
      })
      .mockResolvedValueOnce([entry])
      .mockImplementation(async () => {
        if (vi.mocked(listQueuedRuns).mock.calls.length === 4) drainAfterSlotFreed.resolve();
        return [];
      });
    vi.mocked(startCreatingSession).mockResolvedValue(creatingSessionRun);
    vi.mocked(getAutomation).mockResolvedValue(entry.automation);
    vi.mocked(runQueuedAutomation).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseWorker = () =>
            resolve({ success: true, data: { ...creatingSessionRun, status: 'done' as const } });
        })
    );

    const scheduler = new AutomationScheduler(noopCallbacks);
    const firstDrain = scheduler.drainQueue();
    const secondDrain = scheduler.drainQueue();

    await listing.promise;
    firstList.resolve([]);
    await Promise.all([firstDrain, secondDrain]);

    expect(startCreatingSession).toHaveBeenCalledWith(runId);
    expect(runQueuedAutomation).toHaveBeenCalledOnce();
    expect(listQueuedRuns).toHaveBeenCalledTimes(3);

    releaseWorker?.();
    await drainAfterSlotFreed.promise;
    expect(listQueuedRuns).toHaveBeenCalledTimes(4);
  });
});

describe('AutomationScheduler tick alignment (#7221)', () => {
  const at = (hh: number, mm: number, ss: number, ms = 0) => Date.UTC(2026, 9, 14, hh, mm, ss, ms);

  it('msUntilNextTick lands one second past the next whole minute', () => {
    expect(msUntilNextTick(at(23, 6, 48))).toBe(13_000);
    expect(msUntilNextTick(at(23, 7, 0))).toBe(1_000);
    expect(msUntilNextTick(at(23, 7, 0, 500))).toBe(500);
    expect(msUntilNextTick(at(23, 7, 1))).toBe(60_000);
    expect(msUntilNextTick(at(23, 7, 1, 1))).toBe(59_999);
  });

  it('a run due 12 s after start is seen at :01 past that minute, not a full tick after start', async () => {
    // 云电脑那次:server 07:06:48 起来,排在 07:07:00 的那条 07:07:45 才开始。
    vi.setSystemTime(at(23, 6, 48));
    const scans: number[] = [];
    vi.mocked(markDueCronRunsQueued).mockImplementation(async (now = Date.now()) => {
      scans.push(now);
      return [];
    });

    const scheduler = new AutomationScheduler(noopCallbacks);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scans).toEqual([at(23, 6, 48)]); // 起来就扫一遍(已到点的不等)

    await vi.advanceTimersByTimeAsync(12_999);
    expect(scans).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scans).toEqual([at(23, 6, 48), at(23, 7, 1)]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(scans).toEqual([at(23, 6, 48), at(23, 7, 1), at(23, 8, 1)]);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(scans).toHaveLength(3);
  });
});
