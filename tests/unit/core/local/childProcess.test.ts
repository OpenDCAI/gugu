import { afterEach, describe, expect, it, vi } from 'vitest'

const { calls, record } = vi.hoisted(() => {
  const calls: unknown[][] = []
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args])
    return { name }
  }
  return { calls, record }
})
vi.mock('node:child_process', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: record('spawn'),
    spawnSync: record('spawnSync'),
    execFileSync: record('execFileSync'),
    execSync: record('execSync'),
    fork: record('fork'),
    execFile: record('execFile'),
    exec: record('exec'),
  }
})

const cp = await import('../../../../packages/core/src/local/childProcess')

afterEach(() => { calls.length = 0 })
const last = () => calls.at(-1)

describe('childProcess: windowsHide defaults to true at every call shape', () => {
  it('fills or adds the options object after the args array', () => {
    cp.spawn('git', ['status'], { cwd: '/x' })
    expect(last()).toEqual(['spawn', 'git', ['status'], { windowsHide: true, cwd: '/x' }])
    cp.spawn('git', ['status'])
    expect(last()).toEqual(['spawn', 'git', ['status'], { windowsHide: true }])
    cp.spawn('git')
    expect(last()).toEqual(['spawn', 'git', { windowsHide: true }])
    cp.spawn('git', { cwd: '/x' })
    expect(last()).toEqual(['spawn', 'git', { windowsHide: true, cwd: '/x' }])
    cp.spawnSync('where', ['tmux'], { encoding: 'utf8' })
    expect(last()).toEqual(['spawnSync', 'where', ['tmux'], { windowsHide: true, encoding: 'utf8' }])
    cp.execFileSync('reg', ['query', 'k'])
    expect(last()).toEqual(['execFileSync', 'reg', ['query', 'k'], { windowsHide: true }])
    cp.fork('worker.js', [], { silent: true })
    expect(last()).toEqual(['fork', 'worker.js', [], { windowsHide: true, silent: true }])
  })

  it('puts the options before a callback instead of replacing it', () => {
    const callback = () => {}
    cp.execFile('git', ['status'], callback)
    expect(last()).toEqual(['execFile', 'git', ['status'], { windowsHide: true }, callback])
    cp.execFile('git', callback)
    expect(last()).toEqual(['execFile', 'git', { windowsHide: true }, callback])
    cp.execFile('git', ['status'], { timeout: 1 }, callback)
    expect(last()).toEqual(['execFile', 'git', ['status'], { windowsHide: true, timeout: 1 }, callback])
    cp.exec('code .', callback)
    expect(last()).toEqual(['exec', 'code .', { windowsHide: true }, callback])
    cp.execSync('ver')
    expect(last()).toEqual(['execSync', 'ver', { windowsHide: true }])
  })

  it('keeps an explicit windowsHide: false (a window the person should see)', () => {
    cp.exec('code .', { windowsHide: false })
    expect(last()).toEqual(['exec', 'code .', { windowsHide: false }])
    cp.spawn('devenv.exe', ['a.sln'], { detached: true, windowsHide: false })
    expect(last()).toEqual(['spawn', 'devenv.exe', ['a.sln'], { detached: true, windowsHide: false }])
  })
})
