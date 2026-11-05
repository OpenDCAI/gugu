// The exit paths main wires (signal-exit.ts, process-exit.ts), in process: which code each signal leaves with and
// when it waits for the device runtime host; which crashes take the process down. The real-binary smoke tests
// (serverBootHandoff1013, serverEngineExitTrees) run the same modules in child processes.
import { describe, expect, it, vi } from 'vitest'
import { createSignalExit, type SignalExitDeps } from '../../../../apps/desktop/electron/signal-exit'
import { createFatalExit, stopOnLostLock } from '../../../../apps/desktop/electron/process-exit'

function signals(over: Partial<SignalExitDeps<{ id: string }>> = {}) {
  const exits: number[] = [], reaped: string[] = [], events: string[] = []
  const deps: SignalExitDeps<{ id: string }> = {
    serverMode: true, exitRestart: 75, exitSignedOut: 78,
    stopActivity: () => events.push('stop-activity'),
    singleRun: () => false, sessionFileExists: () => true, supervisedBy: () => undefined,
    markStopped: () => events.push('mark-stopped'), noteExitReason: () => events.push('note-exit'),
    killEngines: (label) => reaped.push(label), exit: (code) => exits.push(code),
    host: () => null, stopHost: async () => {}, warn: vi.fn(),
    ...over,
  }
  return { exit: createSignalExit(deps), exits, reaped, events, deps }
}

describe('signal exit', () => {
  it('registers SIGINT and SIGTERM everywhere, SIGUSR2 (restart) only in server mode', () => {
    const on = (serverMode: boolean) => { const names: string[] = []; signals({ serverMode }).exit.listen((signal) => names.push(signal)); return names }
    expect(on(true)).toEqual(['SIGINT', 'SIGTERM', 'SIGUSR2'])
    expect(on(false)).toEqual(['SIGINT', 'SIGTERM'])
  })

  it('without a device runtime host: stop activity, note the reason, reap, exit with the signal code', () => {
    const t = signals()
    t.exit.exitOnSignal('SIGTERM', 143)
    expect(t.events).toEqual(['stop-activity', 'note-exit'])
    expect(t.reaped).toEqual(['SIGTERM'])
    expect(t.exits).toEqual([143])
  })

  it('a single-run server with no session file leaves signed out, and marks itself stopped unless a supervisor restarts it', () => {
    const t = signals({ singleRun: () => true, sessionFileExists: () => false })
    t.exit.exitOnSignal('SIGTERM', 143)
    expect(t.exits).toEqual([78])
    expect(t.events).toContain('mark-stopped')
    const supervised = signals({ singleRun: () => true, supervisedBy: () => 'systemd' })
    supervised.exit.exitOnSignal('SIGTERM', 143)
    expect(supervised.events).not.toContain('mark-stopped')
    const restart = signals({ singleRun: () => true })
    restart.exit.exitOnSignal('SIGUSR2', 75)
    expect(restart.events).not.toContain('mark-stopped')
  })

  it('in server mode it stops the host first, and a second signal while stopping does not wait again', async () => {
    const stopped = Promise.withResolvers<void>()
    const t = signals({ host: () => ({ id: 'host' }), stopHost: () => stopped.promise })
    t.exit.exitOnSignal('SIGTERM', 143)
    expect(t.exit.stopping()).toBe(true)
    expect(t.exits).toEqual([])
    t.exit.exitOnSignal('SIGINT', 130)
    expect(t.exits, 'another signal = do not wait').toEqual([130])
    stopped.resolve()
    await vi.waitUntil(() => t.exits.length === 2)
    expect(t.exits).toEqual([130, 143])
  })

  it('a host that fails to stop is reported and the process still exits', async () => {
    const t = signals({ host: () => ({ id: 'host' }), stopHost: async () => { throw new Error('stuck') } })
    t.exit.exitOnSignal('SIGTERM', 143)
    await vi.waitUntil(() => t.exits.length === 1)
    expect(t.deps.warn).toHaveBeenCalledWith({ label: 'SIGTERM', error: 'Error: stuck' }, 'device runtime stop on signal failed')
  })
})

describe('fatal exit', () => {
  function fatal(verdict: 'environment' | 'defect') {
    const exits: number[] = [], reaped: string[] = [], recorded: unknown[] = []
    const handle = createFatalExit({ classify: () => verdict, record: (entry) => recorded.push(entry), logger: { error: () => {} }, reap: (label) => reaped.push(label), exit: (code) => exits.push(code) })
    const err = new Error('boom')
    handle(err)
    return { exits, reaped, recorded, err }
  }
  it('an environment failure (network / power) is recorded and the process keeps running', () => {
    const t = fatal('environment')
    expect(t.recorded).toEqual([{ verdict: 'environment', source: 'uncaughtException', err: t.err }])
    expect(t.reaped).toEqual([])
    expect(t.exits).toEqual([])
  })
  it('a defect is recorded, the native legs are reaped, and the process exits 1', () => {
    const t = fatal('defect')
    expect(t.recorded).toHaveLength(1)
    expect(t.reaped).toEqual(['uncaughtException'])
    expect(t.exits).toEqual([1])
  })
})

describe('lost installation lock', () => {
  it.each([
    ['single run, lock lost', true, false, ['lock-lost'], [78]],
    ['single run, lock held', true, true, [], []],
    ['not a single run', false, false, [], []],
    ['lock state unknown', true, undefined, [], []],
  ] as const)('%s', (_name, singleRun, owns, reaped, exits) => {
    const r: string[] = [], e: number[] = []
    stopOnLostLock({ singleRun: () => singleRun, ownsHomeLock: () => owns, logger: { error: () => {} }, reap: (label) => r.push(label), exit: (code) => e.push(code), exitCode: 78 })
    expect(r).toEqual(reaped)
    expect(e).toEqual(exits)
  })
})
