import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createSshUpdateMonitor } from '../../../../apps/desktop/electron/server/ssh-update-monitor'
import { SERVER_UPDATE_STATUS_MARK } from '../../../../packages/core/src/cloud/serverTransition'
import type { ServerUpdateReading } from '../../../../apps/desktop/src/lib/serverSshMachines'

afterEach(() => vi.useRealTimers())
function setup() {
  const children: Array<ReturnType<typeof fake>> = []
  const readings: ServerUpdateReading[] = []
  const spawn = vi.fn((_args: string[]) => { const child = fake(); children.push(child); return child as unknown as ChildProcessWithoutNullStreams })
  const monitor = createSshUpdateMonitor({ machine: async () => ({ ownerUserId: 'account', target: { destination: 'host', display: 'host' } }), controlPath: () => '/socket',
    spawnSsh: spawn, emit: (_id, r) => readings.push(r) })
  return { monitor, children, readings, spawn }
}
function fake() { return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() }) }
const state = (phase = 'migrating', request = Date.now()) => ({ request, target: '0.3.1', phase, at: Date.now(), pid: 2, done: 2, total: 3 })
const line = (transition: unknown) => `${SERVER_UPDATE_STATUS_MARK}${JSON.stringify({ at: Date.now(), transition })}\n`

describe('SSH update observation independent of account RPC', () => {
  it('reads framed progress after shell noise, preserves it on disconnect, and resumes the same request', async () => {
    vi.useFakeTimers(); const s = setup()
    s.monitor.read('device'); await Promise.resolve()
    expect(s.spawn.mock.calls[0]![0].at(-1)).toContain('update-status --account account --watch')
    const text = line(state())
    s.children[0]!.stdout.write(`shell banner\n${text.slice(0, 19)}`); s.children[0]!.stdout.write(text.slice(19))
    expect(s.readings.at(-1)).toMatchObject({ reachable: true, transition: { phase: 'migrating' } })
    s.children[0]!.emit('close', 255)
    expect(s.readings.at(-1)).toMatchObject({ reachable: false, transition: { phase: 'migrating' } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(s.spawn).toHaveBeenCalledTimes(2)
    s.children[1]!.stdout.write(line(state('ready')))
    s.children[1]!.emit('close', 0)
    expect(s.readings.at(-1)).toMatchObject({ reachable: true, transition: { phase: 'ready' } })
    s.monitor.dispose()
  })
  it('does not accept an old terminal snapshot as acknowledgement of a new request', async () => {
    const s = setup(); s.monitor.read('device'); await Promise.resolve()
    s.children[0]!.stdout.write(line(state('ready', 7))); s.children[0]!.emit('close', 0)
    s.monitor.read('device', true, true); await Promise.resolve()
    s.children[1]!.stdout.write(line(state('ready', 7)))
    expect(s.readings.at(-1)?.pending).toBe(true)
    s.children[1]!.stdout.write(line(state('stopping', 8)))
    expect(s.readings.at(-1)).toMatchObject({ pending: false, transition: { request: 8, phase: 'stopping' } })
    s.monitor.dispose()
  })
})
