import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import vitestRunTmpRoot from '../../../scripts/vitest-run-tmp-root'

describe('vitest per-run tmp root (#6272)', () => {
  it('reaches the worker: os.tmpdir() is the run root the globalSetup created', () => {
    // 这条红 = worker 拷 env 的时刻早于 globalSetup(或 globalSetup 没挂上),整套机制空转。
    const root = process.env.GUGU_VITEST_TMP_ROOT
    expect(root).toBeTruthy()
    expect(tmpdir()).toBe(root)
    expect(basename(dirname(root!))).toBe('gv')
  })

  it('sweeps roots of dead runs, keeps live ones, and tears its own root down', () => {
    const outer = tmpdir()
    const parent = join(outer, 'gv')
    // 默认 pool=forks ⇒ ppid 是 vitest 主进程,必活。macOS 的 pid 上限 99998,Linux 默认 4194304 ⇒ 这个 pid 不会是活进程。
    const dead = join(parent, (4194303).toString(36))
    const live = join(parent, process.ppid.toString(36))
    mkdirSync(dead, { recursive: true })
    writeFileSync(join(dead, 'leftover'), 'x')
    mkdirSync(live, { recursive: true })

    const teardown = vitestRunTmpRoot()
    const own = join(parent, process.pid.toString(36))
    try {
      expect(teardown).toBeTypeOf('function')
      expect(existsSync(dead)).toBe(false)
      expect(existsSync(live)).toBe(true)
      expect(process.env.TMPDIR).toBe(own)
      expect(tmpdir()).toBe(own)
      expect(existsSync(own)).toBe(true)
      // 同一进程第二次(下一个 project 的 globalSetup)沿用,不再开新根、不给第二个 teardown。
      expect(vitestRunTmpRoot()).toBeUndefined()
      writeFileSync(join(own, 'made-by-a-test'), 'x')
    } finally {
      teardown?.()
    }
    expect(existsSync(own)).toBe(false)
    expect(tmpdir()).toBe(outer)
    expect(existsSync(live)).toBe(true)
  })
})
