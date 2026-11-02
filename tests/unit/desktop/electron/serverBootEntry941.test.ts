import ts from 'typescript'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { sessionBootTasks } from '../../../../apps/desktop/electron/session/main/core/boot-tasks'
import { resolveDeviceHostInfo } from '../../../../packages/core/src/cloud/deviceHostInfo'
import { hydrateLife, shouldStartOnHydrate } from '../../../../packages/core/src/local/session-life/step'
import { busyForVersionSwitch, parseAgentStatusView } from '../../../../packages/core/src/shared/agentStatus'
import type { Hold } from '../../../../packages/core/src/local/session-life/types'

vi.mock('../../../../packages/core/src/cloud/remoteTunnel', () => ({ tunnelRelayUp: () => false, tunnelActiveAt: () => null }))
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }))

const requireBuiltin = createRequire(import.meta.url)
const entry = path.resolve(__dirname, '../../../../apps/desktop/electron/session/main/embedded-boot.ts')

/** Execute the real composition root; unrelated service boundaries are inert, not a copied boot sequence. */
async function boot(fail: string, fatal = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-boot-entry941-'))
  const tasks = sessionBootTasks
  for (const failure of tasks.snapshot()) tasks.clearTask(failure.taskId)
  const registered = vi.fn()
  const statusHooks: Array<(event: unknown) => void> = []
  const sessionHooks = new Map<string, (id: string) => void>()
  const rows: Record<string, Array<{ id: string }>> = { sessions: [], projects: [] }
  const states: Array<{ conversationId: string; runtime: 'acp'; status: { status: 'working'; detail: 'running' } }> = []
  const pending = new Map<string, { queued: number[]; dispatching: number[] }>()
  const lifeRows = new Map<string, { archived: boolean; hold: Hold | null }>()
  const noop: unknown = new Proxy(function () { return noop }, {
    get(_target, key) {
      if (key === 'then') return undefined
      if (key === Symbol.iterator) return function* () {}
      return noop
    },
  })
  const stub = noop as Record<string, unknown>
  const fault = (operation: string) => () => { if (fail === operation) throw new Error(`refused ${operation}`) }
  const overrides: Record<string, Record<string, unknown>> = {
    './core/boot-tasks': { sessionBootTasks: tasks },
    '@main/core/session-timeline/service': { listSessionStates: () => ({ projects: [], sessions: states }) },
    '@gugu/core/shared/agentStatus': { busyForVersionSwitch, parseAgentStatusView },
    '@main/core/sessions/session-pending': { lifeSessions: () => [...pending.keys()], lifeStore: {
      pending: (id: string) => pending.get(id)!, read: (id: string) => lifeRows.get(id) ?? { archived: false, hold: null },
    } },
    '@gugu/core/local/session-life/step': { hydrateLife, shouldStartOnHydrate },
    './core/integrations/integration-connection-service': { integrationConnectionService: new Proxy({ hasPendingAuthorizations: () => false }, { get: (target, key) => key in target ? target[key as keyof typeof target] : stub[key as string] }) },
    '@main/db/schema': { sessions: { name: 'sessions' }, projects: { name: 'projects' } },
    '@main/db/client': { db: { select: () => ({ from: (table: { name: string }) => ({
      where: () => ({ all: () => rows[table.name] }),
    }) }) } },
    electron: { app: { getPath: () => home, getVersion: () => '0.3.1-fixture', isPackaged: true }, session: { defaultSession: { resolveProxy: () => 'DIRECT' } } },
    '@main/db/initialize': { initializeDatabase: async () => { if (fatal) throw new Error('database init failed') } },
    '../../migrations/task-to-session': { runTaskToSessionOnce: async () => null },
    '../../migrations/session-naming': { runSessionNamingOnce: async () => null },
    '@main/core/sessions/attachments/session-attachment-store': { sweepOrphanSessionAttachmentDirectories: async () => 0 },
    '@main/core/data-dir-occupancy': { dataDirHeldByAnotherHost: () => ({ held: false }) },
    '@main/core/pty/tmux-session-name': { listTmuxSessionNames: async () => new Set() },
    '@main/core/projects/operations/migrate-project-kind': { migrateProjectKind: () => [] },
    '@main/core/usage/run-interval-recorder': { closeInterruptedRunIntervals: fault('interval'), installRunIntervalRecorder: noop },
    '@main/core/sessions/sendMessage': { claimInterruptedDispatches: fault('dispatch') },
    '@main/core/sessions/session-deferred-messages': { claimInterruptedDeferredMessages: fault('deferred') },
    '@main/core/agent-status/agent-status-writer': { agentStatusWriter: {
      initialize: noop, forget: noop, settleAfterRestart: fault('status'),
      on: (_name: string, callback: (event: unknown) => void) => { statusHooks.push(callback); return () => {} },
    } },
    '@main/core/sessions/session-events': { sessionEvents: {
      on: (name: string, callback: (id: string) => void) => { sessionHooks.set(name, callback); return () => {} },
    } },
    '@shared/lib/ipc/rpc': { registerRPCRouter: registered },
  }
  const load = (id: string) => {
    if (id.startsWith('node:')) return requireBuiltin(id)
    return new Proxy(overrides[id] ?? {}, { get: (target, key) => key in target ? target[key as string] : stub[key as string] })
  }
  const compiled = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} as {
    bootSessionHostCore: (options: unknown) => Promise<void>
    sessionpageBootFailures: () => unknown[]
    sessionpageVersionSwitchActivity: () => { busy: boolean; busyAgents: number }
  } }
  runInNewContext(compiled.outputText, { require: load, module, exports: module.exports, process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, __dirname: path.dirname(entry) })
  try {
    await module.exports.bootSessionHostCore({ hostIpc: { ipcMain: {} }, browserFeatures: false, scheduleDiscovery: async () => {} })
    return { tasks, registered, statusHooks, sessionHooks, rows, states, pending, lifeRows, activity: module.exports.sessionpageVersionSwitchActivity, readFailures: module.exports.sessionpageBootFailures, failures: module.exports.sessionpageBootFailures() }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

describe('real session host boot entry', () => {
  it('counts each interrupted session once across live status and admitted delivery', async () => {
    const result = await boot('')
    result.states.push({ conversationId: 'working', runtime: 'acp', status: { status: 'working', detail: 'running' } })
    result.pending.set('working', { queued: [], dispatching: [1] })
    expect(result.activity()).toEqual({ busy: true, busyAgents: 1 })
    result.pending.set('chat-ui-delivery', { queued: [2, 3], dispatching: [] })
    expect(result.activity()).toEqual({ busy: true, busyAgents: 2 })
  })
  it.each(['queued', 'dispatching'] as const)('keeps the account busy while an admitted delivery is %s', async state => {
    const result = await boot('')
    expect(result.activity()).toEqual({ busy: false, busyAgents: 0 })
    result.pending.set('scheduled-or-session-message', { queued: [], dispatching: [], [state]: [1] })
    expect(result.activity()).toEqual({ busy: true, busyAgents: 1 })
    result.pending.set('scheduled-or-session-message', { queued: [], dispatching: [] })
    expect(result.activity()).toEqual({ busy: false, busyAgents: 0 })
  })

  it.each([
    { archived: true, hold: null },
    { archived: false, hold: { reason: 'user-stop', barrier: 1 as never } },
    { archived: false, hold: { reason: 'start-failed', barrier: 1 as never, stage: 'identity', awaitsPerson: true, cause: { name: 'IdentityMissing', message: 'Needs the person' } } },
  ] satisfies Array<{ archived: boolean; hold: Hold | null }>)('does not block upgrades on an old queue held for a person or archived ($hold.reason)', async row => {
    const result = await boot('')
    result.pending.set('stopped', { queued: [1], dispatching: [] })
    result.lifeRows.set('stopped', row)
    expect(result.activity()).toEqual({ busy: false, busyAgents: 0 })
  })

  it.each(['interval', 'status', 'dispatch', 'deferred'])('continues registration after %s recovery throws and projects the failure to Devices', async operation => {
    const result = await boot(operation)
    expect(result.registered).toHaveBeenCalledOnce()
    expect(result.failures).toEqual([expect.objectContaining({ message: `refused ${operation}` })])
    const info = resolveDeviceHostInfo({ GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: '/fixture', GUGU_TASK_HOST_USER_DATA: '/fixture/account' }, {
      readText: file => file.endsWith('/activity.json') ? JSON.stringify({ bootFailures: result.failures }) : null,
      uid: () => 1000,
    })
    expect(info.server_boot_failures).toEqual(result.failures)
  })
  it('retains the fatal boundary for real database initialisation failure', async () => {
    await expect(boot('', true)).rejects.toThrow('database init failed')
  })
  it('wires archive (the one gone event, deletion included) and successful task completion to the same ledger cleanup', async () => {
    const result = await boot('')
    for (const event of ['session:archived']) {
      result.tasks.record('outbox-drain', 'task', 'refused')
      result.sessionHooks.get(event)!('task')
      expect(result.tasks.snapshot()).toEqual([])
    }
    result.tasks.record('outbox-drain', 'task', 'refused')
    for (const callback of result.statusHooks) callback({ sessionId: 'task', reading: { status: 'idle', detail: 'done' } })
    expect(result.tasks.snapshot()).toEqual([])
  })
  it('clears disappeared tasks without discarding a still-existing project recovery failure', async () => {
    const result = await boot('')
    result.tasks.record('outbox-drain', 'deleted-task', 'refused')
    result.tasks.record('project-open', 'existing-project', 'project refused')
    result.rows.projects.push({ id: 'existing-project' })
    expect(result.readFailures()).toEqual([{ operation: 'project-open', taskId: 'existing-project', message: 'project refused' }])
    result.rows.projects.length = 0
    expect(result.readFailures()).toEqual([])
  })
})
