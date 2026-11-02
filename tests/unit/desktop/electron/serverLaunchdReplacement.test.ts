import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installService, restartServerAfterLogin } from '../../../../apps/desktop/electron/server/server-service'

const command = vi.hoisted(() => vi.fn())
vi.mock('@gugu/core/local/childProcess', async importOriginal => ({
  ...await importOriginal<typeof import('@gugu/core/local/childProcess')>(),
  spawnSync: (cmd: string, args: string[]) => command(cmd, args),
  execFileSync: (cmd: string, args: string[]) => {
    const r = command(cmd, args)
    if (r.status !== 0) throw Object.assign(new Error('command failed'), r)
    return r.stdout
  },
}))

let home: string, environment: NodeJS.ProcessEnv
const platform = process.platform
const domain = `gui/${os.userInfo().uid}`
let loaded: boolean, removing: boolean, running: boolean, reads: number
let mode: 'normal' | 'bootout-error' | 'print-error' | 'stuck' | 'bootstrap-error'
const result = (status = 0, stdout = '', stderr = '') => ({ status, stdout, stderr, signal: null })

beforeEach(() => {
  vi.useFakeTimers()
  environment = { ...process.env }
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-launchd-replacement-'))
  fs.mkdirSync(path.join(home, 'data'))
  process.env.GUGU_SERVER_HOME = home
  process.env.GUGU_TASK_HOST_APP_PATH = path.join(home, 'versions/2.0.0/app')
  process.env.GUGU_TASK_HOST_VERSION = '2.0.0'
  delete process.env.GUGU_CLOUD_COMPUTER
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  loaded = true; removing = false; running = false; reads = 0; mode = 'normal'
  command.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'ps') return result(0, running ? `${home}/versions/2.0.0/app/dist-electron/server.js run` : '/unrelated/process')
    if (cmd !== 'launchctl') return result(1, '', 'unsupported fixture command')
    const [verb, target] = args
    if (verb === 'print') {
      if (target?.startsWith(domain) && loaded) {
        if (removing) {
          reads++
          if (mode === 'print-error') return result(5, '', 'IPC read failed')
          if (mode !== 'stuck' && reads >= 2) {
            loaded = false
            // The outgoing process writes its final stop marker after bootout returned.
            fs.writeFileSync(path.join(home, 'data/stopped'), '')
          }
        }
        if (loaded) return result(0, 'exit timeout = 30\n')
      }
      return result(113, '', `Could not find service "gugu" in domain ${target}`)
    }
    if (verb === 'bootout') {
      if (mode === 'bootout-error') return result(5, 'bootout stdout', 'bootout denied')
      removing = true
      return result()
    }
    if (verb === 'bootstrap') {
      if (loaded || mode === 'bootstrap-error') return result(5, 'bootstrap stdout', 'Bootstrap failed: 5')
      expect(fs.existsSync(path.join(home, 'data/stopped'))).toBe(false)
      running = true
      fs.writeFileSync(path.join(home, 'data/server.lock'), String(process.pid))
      return result()
    }
    throw new Error(`unexpected launchctl ${args.join(' ')}`)
  })
})

afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); command.mockReset()
  Object.defineProperty(process, 'platform', { value: platform })
  process.env = environment
  const directory = home
  expect(directory.startsWith(path.join(os.tmpdir(), 'gugu-launchd-replacement-'))).toBe(true)
  fs.rmSync(directory, { recursive: true, force: true })
})

it('waits for the old label to disappear and clears its late stopped marker before one bootstrap', async () => {
  const pending = installService(() => undefined)
  await vi.runAllTimersAsync()
  expect(await pending).toBe(true)
  expect(reads).toBe(2)
  expect(command.mock.calls.filter(([, args]) => args[0] === 'bootstrap')).toHaveLength(1)
})

it('does not bootstrap after bootout failed and retains the command, status and both output streams', async () => {
  mode = 'bootout-error'
  await expect(installService(() => undefined)).rejects.toThrow(/bootout.*status=5[\s\S]*bootout stdout[\s\S]*bootout denied/)
  expect(command.mock.calls.some(([, args]) => args[0] === 'bootstrap')).toBe(false)
})

it('does not mistake an IPC error for proof that the old label disappeared', async () => {
  mode = 'print-error'
  const pending = expect(installService(() => undefined)).rejects.toThrow(/status=5[\s\S]*IPC read failed/)
  await vi.runAllTimersAsync(); await pending
  expect(command.mock.calls.some(([, args]) => args[0] === 'bootstrap')).toBe(false)
})

it('reports the last print result if the actual exit timeout plus margin is exhausted', async () => {
  mode = 'stuck'
  const pending = expect(installService(() => undefined)).rejects.toThrow(/did not unload[\s\S]*exit timeout = 30/)
  await vi.runAllTimersAsync(); await pending
  expect(command.mock.calls.some(([, args]) => args[0] === 'bootstrap')).toBe(false)
})

it('preserves both domain bootstrap errors and never retries the same bootstrap', async () => {
  mode = 'bootstrap-error'
  const pending = expect(installService(() => undefined)).rejects.toThrow(/gui\/[\s\S]*status=5[\s\S]*bootstrap stdout[\s\S]*Bootstrap failed: 5[\s\S]*user\//)
  await vi.runAllTimersAsync(); await pending
  expect(command.mock.calls.filter(([, args]) => args[0] === 'bootstrap')).toHaveLength(2)
})

it('start tells the terminal which live PID already holds the lock', () => {
  fs.writeFileSync(path.join(home, 'data/server.lock'), String(process.pid))
  const lines: string[] = []
  restartServerAfterLogin(line => lines.push(line))
  expect(lines.join('\n')).toContain(`pid ${process.pid}`)
  expect(command.mock.calls.some(([cmd]) => cmd === 'launchctl')).toBe(false)
})
