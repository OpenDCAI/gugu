import { describe, expect, it, vi } from 'vitest'
import { SessionBootTasks, parseSessionBootFailures } from '../../../../packages/core/src/shared/sessionBootTasks'

// The same executor is used by every task-owned startup side effect, on both sides of the bundle bridge.
const operations = ['outbox-drain', 'dispatch-recovery', 'status-recovery', 'run-interval-recovery', 'deferred-recovery', 'deferred-drain', 'roster-rehydrate', 'roster-release', 'relay-restore', 'platform-recovery', 'inbox-wake', 'project-open', 'agent-reconcile', 'group-reconcile']
describe('task-owned boot boundary', () => {
  it.each(operations)('%s cannot reject host boot and retains a device-visible failure', async operation => {
    const report = vi.fn()
    const tasks = new SessionBootTasks(report)
    const other = vi.fn()
    await expect(Promise.all([
      tasks.run(operation, 'broken', () => { throw new Error('boot task refused') }),
      tasks.run(operation, 'healthy', other),
    ])).resolves.toBeDefined()
    expect(other).toHaveBeenCalledOnce()
    expect(parseSessionBootFailures(tasks.snapshot())).toEqual([{ operation, taskId: 'broken', message: 'boot task refused' }])
    expect(report).toHaveBeenCalledOnce()
  })
  it('also isolates synchronous task transactions', () => {
    const tasks = new SessionBootTasks(vi.fn())
    expect(tasks.runSync('dispatch-recovery', 'bad', () => { throw new Error('SQLite refusal') })).toBeUndefined()
    expect(tasks.runSync('dispatch-recovery', 'good', () => 1)).toBe(1)
    expect(tasks.snapshot()[0]?.taskId).toBe('bad')
  })
  it('rejects malformed diagnostics without affecting a heartbeat', () => {
    expect(parseSessionBootFailures([null, {}, { operation: 'x', taskId: 1, message: 'y' }])).toEqual([])
  })
})
