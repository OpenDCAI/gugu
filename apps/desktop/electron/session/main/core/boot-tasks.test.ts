import { LifecycleMap, err, ok } from '@gugu/session-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRecoveredProjectBootFailures, sessionBootTasks } from './boot-tasks';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
afterEach(() => { for (const failure of sessionBootTasks.snapshot()) sessionBootTasks.clearTask(failure.taskId); });

describe('project boot failure recovery', () => {
  it('retains a failed or in-flight project, then clears only its completed reopen', async () => {
    const providers = new LifecycleMap<object, string, string>();
    sessionBootTasks.record('project-open', 'project', 'startup read timed out');
    sessionBootTasks.record('dispatch-sweep', 'project', 'unrelated failure');
    await providers.provision('project', async () => err('still unreadable'));
    expect(clearRecoveredProjectBootFailures(id => providers.has(id))).toHaveLength(2);
    const ready = Promise.withResolvers<ReturnType<typeof ok<object>>>();
    const reopening = providers.provision('project', () => ready.promise);
    expect(clearRecoveredProjectBootFailures(id => providers.has(id))).toHaveLength(2);
    ready.resolve(ok({}));
    await reopening;
    expect(clearRecoveredProjectBootFailures(id => providers.has(id))).toEqual([
      expect.objectContaining({ operation: 'dispatch-sweep', taskId: 'project' }),
    ]);
  });

  it('reconciles a startup result recorded after a concurrent successful open', async () => {
    const providers = new LifecycleMap<object, string, string>();
    await providers.provision('recovered', async () => ok({}));
    sessionBootTasks.record('project-open', 'recovered', 'late startup result');
    sessionBootTasks.record('project-open', 'still-failed', 'actual failure');
    expect(clearRecoveredProjectBootFailures(id => providers.has(id))).toEqual([
      expect.objectContaining({ operation: 'project-open', taskId: 'still-failed' }),
    ]);
  });
});
