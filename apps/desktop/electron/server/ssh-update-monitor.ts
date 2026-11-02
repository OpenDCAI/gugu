import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from '@gugu/core/local/childProcess'
import { SERVER_UPDATE_STATUS_MARK, parseServerTransition } from '@gugu/core/cloud/serverTransition'
import type { ServerUpdateReading } from '../../src/lib/serverSshMachines'
import type { SshTarget } from './ssh-install/logic'
import { sshBatchArgs } from './ssh-batch'
import { desktopServerChannel, remoteServerPaths } from './server-names'

type Machine = { ownerUserId: string; target: SshTarget }
type Run = { child?: ChildProcessWithoutNullStreams; retry?: ReturnType<typeof setTimeout>; reading: ServerUpdateReading; stopped: boolean }

/** Main-process lifetime; a settings component never owns or cancels this observer. */
export function createSshUpdateMonitor(options: {
  machine: (deviceId: string) => Promise<Machine | null>
  controlPath: () => string | null
  emit: (deviceId: string, reading: ServerUpdateReading) => void
  spawnSsh?: (args: string[]) => ChildProcessWithoutNullStreams
}) {
  const runs = new Map<string, Run>()
  let revision = 0
  const publish = (id: string, run: Run, reading: ServerUpdateReading) => {
    run.reading = { ...reading, revision: ++revision }
    options.emit(id, run.reading)
  }
  const start = async (id: string, run: Run): Promise<void> => {
    const machine = await options.machine(id)
    if (run.stopped || !machine) return
    const after = run.reading.pending ? ` --after ${run.reading.after ?? 0}` : ''
    const command = `exec ${remoteServerPaths(desktopServerChannel()).binTilde} update-status --account ${machine.ownerUserId} --watch${after}`
    const child = (options.spawnSsh ?? (args => spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })))(sshBatchArgs(machine.target, command, options.controlPath()))
    run.child = child
    let buffer = ''
    let answered = false
    let settled = false
    const first = setTimeout(() => { if (!answered) child.kill('SIGTERM') }, 15_000)
    const finish = (code?: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(first)
      if (run.stopped) return
      if (!answered && code === 2) {
        publish(id, run, { ...run.reading, reachable: false, supported: false, pending: false })
        run.child = undefined
        return
      }
      const active = run.reading.pending || (run.reading.transition && ['accepted', 'stopping', 'starting', 'migrating'].includes(run.reading.transition.phase)) || run.reading.transition?.search?.state === 'running'
      if (!answered || active) {
        publish(id, run, { ...run.reading, reachable: false })
        // Retry only an observed/requested operation; never poll every idle device.
        if (active) run.retry = setTimeout(() => void start(id, run), 5_000)
      }
      run.child = undefined
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 131_072) { child.kill('SIGTERM'); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.startsWith(SERVER_UPDATE_STATUS_MARK)) continue
        try {
          const value = JSON.parse(line.slice(SERVER_UPDATE_STATUS_MARK.length)) as { transition?: unknown }
          if (!('transition' in value)) continue
          const transition = value.transition === null ? null : parseServerTransition(value.transition)
          if (value.transition !== null && !transition) continue
          answered = true; clearTimeout(first)
          if (run.reading.pending && (!transition || transition.request <= (run.reading.after ?? 0))) continue
          publish(id, run, { transition, reachable: true, supported: true, pending: false })
        } catch { /* Login-shell output or incomplete protocol lines are not a status. */ }
      }
    })
    child.stderr.resume()
    child.stdin.end()
    child.on('error', () => finish())
    child.on('close', finish)
  }
  const stop = (id: string) => {
    const run = runs.get(id)
    if (!run) return
    run.stopped = true
    if (run.retry) clearTimeout(run.retry)
    run.child?.kill('SIGTERM')
    runs.delete(id)
  }
  return {
    read(id: string, force = false, pending = false): ServerUpdateReading {
      const known = runs.get(id)
      if (known && !force) return known.reading
      const reading: ServerUpdateReading = pending
        ? { transition: known?.reading.transition ?? null, reachable: true, pending: true, after: known?.reading.transition?.request ?? 0 }
        : known?.reading ?? { transition: null, reachable: false, pending: false }
      stop(id)
      const run: Run = { reading, stopped: false }
      runs.set(id, run)
      publish(id, run, reading)
      void start(id, run).catch(() => publish(id, run, { ...reading, reachable: false }))
      return run.reading
    },
    stop,
    cancelPending(id: string): void {
      const run = runs.get(id)
      if (run?.reading.pending) { stop(id); options.emit(id, { ...run.reading, pending: false }) }
    },
    dispose(): void { for (const id of [...runs.keys()]) stop(id) },
  }
}
