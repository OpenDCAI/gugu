/**
 * 宿主上一次是怎么退出的(electron/lib/exit-reason.ts):开机收残据此说清在跑的那一轮是被什么打断的。
 * 换版先写 update,进程自己正常退出写 restart 但不盖掉 update;没留话 = 没正常退出;读一次就删。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { noteExitReason, takeLastExit } from '../../../../apps/desktop/electron/lib/exit-reason'

describe('exit reason', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-reason-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('nothing left = unclean; a restart is read once', () => {
    expect(takeLastExit(dir)).toBe('unclean')
    noteExitReason(dir, 'restart')
    expect(takeLastExit(dir)).toBe('restart')
    expect(takeLastExit(dir)).toBe('unclean')
  })

  it('the supervisor said update before ending it: the process own restart note does not overwrite it', () => {
    noteExitReason(dir, 'update')
    noteExitReason(dir, 'restart')
    expect(takeLastExit(dir)).toBe('update')
  })

  it('an unreadable or missing directory never throws on the way out', () => {
    expect(() => noteExitReason(path.join(dir, 'missing', 'deeper'), 'restart')).not.toThrow()
    fs.writeFileSync(path.join(dir, 'last-exit.json'), 'not json')
    expect(takeLastExit(dir)).toBe('unclean')
  })
})
