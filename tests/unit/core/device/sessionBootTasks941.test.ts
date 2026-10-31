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
  it('records a non-Error result object as readable text', () => {
    const tasks = new SessionBootTasks(vi.fn())
    tasks.record('project-open', 'p1', { type: 'path-not-found', path: '/gone' })
    tasks.record('project-open', 'p2', { type: 'error', message: 'Project not found: p2' })
    expect(tasks.snapshot().map(row => row.message)).toEqual(['{"type":"path-not-found","path":"/gone"}', 'Project not found: p2'])
  })
  it('rejects malformed diagnostics without affecting a heartbeat', () => {
    expect(parseSessionBootFailures([null, {}, { operation: 'x', taskId: 1, message: 'y' }])).toEqual([])
  })
  it('clears successful operations and removes all failures when a task is gone or succeeds', async () => {
    const tasks = new SessionBootTasks(vi.fn())
    tasks.record('outbox-drain', 'a', 'failed')
    await tasks.run('outbox-drain', 'a', () => 1)
    expect(tasks.snapshot()).toEqual([])
    tasks.record('status-recovery', 'a', 'failed')
    tasks.record('outbox-drain', 'a', 'failed')
    tasks.record('outbox-drain', 'b', 'failed')
    tasks.clearTask('a')
    expect(tasks.snapshot().map(row => row.taskId)).toEqual(['b'])
  })
  it('bounds the ledger and cannot throw while serialising or reporting a failure', () => {
    const tasks = new SessionBootTasks(() => { throw new Error('logger failed') })
    for (let id = 0; id < 102; id++) tasks.record('boot', String(id), 'x'.repeat(1000))
    expect(tasks.snapshot()).toHaveLength(100)
    expect(tasks.snapshot()[0]).toMatchObject({ taskId: '2', message: 'x'.repeat(500) })
    const hostile = new Error('unreadable')
    Object.defineProperty(hostile, 'message', { get: () => { throw new Error('getter failed') } })
    expect(() => tasks.runSync('boot', 'hostile', () => { throw hostile })).not.toThrow()
    expect(() => tasks.record('boot', 'no-prototype', Object.create(null))).not.toThrow()
    expect(tasks.snapshot().at(-1)?.message).toContain('could not be read')
  })
})
