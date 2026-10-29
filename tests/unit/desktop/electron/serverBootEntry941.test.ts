import ts from 'typescript'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { SessionBootTasks } from '../../../../packages/core/src/shared/sessionBootTasks'
import { resolveDeviceHostInfo } from '../../../../packages/core/src/cloud/deviceHostInfo'

vi.mock('../../../../packages/core/src/cloud/remoteTunnel', () => ({ tunnelRelayUp: () => false, tunnelActiveAt: () => null }))

const requireBuiltin = createRequire(import.meta.url)
const entry = path.resolve(__dirname, '../../../../apps/desktop/electron/session/main/embedded-boot.ts')

/** Execute the real composition root; unrelated service boundaries are inert, not a copied boot sequence. */
async function boot(fail: string, fatal = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-boot-entry941-'))
  const tasks = new SessionBootTasks(vi.fn())
  const registered = vi.fn()
  const statusHooks: Array<(event: unknown) => void> = []
  const sessionHooks = new Map<string, (id: string) => void>()
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
    electron: { app: { getPath: () => home, isPackaged: true }, session: { defaultSession: { resolveProxy: () => 'DIRECT' } } },
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
  } }
  runInNewContext(compiled.outputText, { require: load, module, exports: module.exports, process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, __dirname: path.dirname(entry) })
  try {
    await module.exports.bootSessionHostCore({ hostIpc: { ipcMain: {} }, browserFeatures: false, scheduleDiscovery: async () => {} })
    return { tasks, registered, statusHooks, sessionHooks, failures: module.exports.sessionpageBootFailures() }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

describe('real session host boot entry', () => {
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
  it('wires archive, delete and successful task completion to the same ledger cleanup', async () => {
    const result = await boot('')
    for (const event of ['session:archived', 'session:deleted']) {
      result.tasks.record('outbox-drain', 'task', 'refused')
      result.sessionHooks.get(event)!('task')
      expect(result.tasks.snapshot()).toEqual([])
    }
    result.tasks.record('outbox-drain', 'task', 'refused')
    for (const callback of result.statusHooks) callback({ sessionId: 'task', reading: { status: 'idle', detail: 'done' } })
    expect(result.tasks.snapshot()).toEqual([])
  })
})
