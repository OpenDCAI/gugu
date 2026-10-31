// #6264 咕咕 server 生命周期的几件小事:孤儿账号进程自己退出、日志有上限、SSH 命令用在跑的那一版、
// 续期后的登录态写不进盘也不丢、升级前的自检、账号进程的内存设置。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchParent } from '../../../../apps/desktop/electron/server/server-parent-watch'
import { rotateByCopyTruncate, rotateByRename } from '../../../../apps/desktop/electron/server/server-log-rotate'
import { chooseVersionBinary, runningVersionOf } from '../../../../apps/desktop/electron/server/server-version-match'
import { runChecks } from '../../../../apps/desktop/electron/server/server-selftest'
import { pruneVersions } from '../../../../apps/desktop/electron/server/server-account-versions'
import { isOwnProcessAlive } from '../../../../apps/desktop/electron/server/process-alive'
import { accountProcessEnv } from '../../../../apps/desktop/electron/server/server-supervisor'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, safeStorage: {} }))

const dirs: string[] = []
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-lifecycle-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('账号进程盯着守护进程', () => {
  it('父进程换人(守护进程被 kill -9 / OOM,被 init 收养)就报一次孤儿', () => {
    let tick: () => void = () => undefined
    let parent = 100
    const onOrphaned = vi.fn()
    watchParent({ expectedParent: 100, currentParent: () => parent, onOrphaned, setInterval: (fn) => ((tick = fn), {}), clearInterval: () => undefined })
    tick()
    expect(onOrphaned).not.toHaveBeenCalled()
    parent = 1
    tick()
    tick()
    expect(onOrphaned).toHaveBeenCalledTimes(1)
    expect(onOrphaned).toHaveBeenCalledWith({ expected: 100, now: 1 })
  })

  it('本来就没有守护进程(手动跑、父进程号 ≤ 1):不盯', () => {
    const setInterval = vi.fn()
    watchParent({ expectedParent: 1, currentParent: () => 1, onOrphaned: vi.fn(), setInterval })
    expect(setInterval).not.toHaveBeenCalled()
  })

  it('锁里的进程号活着但被别的程序复用了:不算我们的进程,锁可以接管', () => {
    expect(isOwnProcessAlive(process.pid, 'server.js', () => '/usr/sbin/nginx -g daemon off;')).toBe(false)
    expect(isOwnProcessAlive(process.pid, 'server.js', () => '/srv/versions/0.2.140/node/bin/node /srv/versions/0.2.140/app/dist-electron/server.js run-account x')).toBe(true)
    expect(isOwnProcessAlive(process.pid, 'server.js', () => null)).toBe(true)
    expect(isOwnProcessAlive(2 ** 22 + 7, 'server.js', () => 'server.js')).toBe(false)
  })
})

describe('日志有上限', () => {
  it('supervisor.log 超过上限整份挪成 .1(只留一份旧的)', () => {
    const file = path.join(tmp(), 'supervisor.log')
    fs.writeFileSync(file, 'x'.repeat(2_000))
    fs.writeFileSync(`${file}.1`, 'older')
    expect(rotateByRename(file, 1_000)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toHaveLength(2_000)
    fs.writeFileSync(file, 'small')
    expect(rotateByRename(file, 1_000)).toBe(false)
  })

  it('service.log 被别的进程以追加方式持有着:copytruncate,之后接着从新的末尾写、没有空洞', () => {
    const file = path.join(tmp(), 'service.log')
    const fd = fs.openSync(file, 'a')
    fs.writeSync(fd, 'y'.repeat(3_000))
    expect(rotateByCopyTruncate(file, 1_000)).toBe(true)
    expect(fs.statSync(file).size).toBe(0)
    expect(fs.statSync(`${file}.1`).size).toBe(3_000)
    fs.writeSync(fd, 'after')
    fs.closeSync(fd)
    expect(fs.readFileSync(file, 'utf8')).toBe('after')
  })
})

describe('reclamation preserves explicit live and rollback ownership', () => {
  it('preserves protected versions and active staging without mtime extras', () => {
    const versions = tmp()
    for (const [i, v] of ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7'].entries()) {
      fs.mkdirSync(path.join(versions, v))
      fs.utimesSync(path.join(versions, v), 1_000 + i, 1_000 + i)
    }
    fs.mkdirSync(path.join(versions, '.download-abc'))
    pruneVersions(versions, ['0.1.0', '0.1.8'])
    expect(fs.readdirSync(versions).sort()).toEqual(['.download-abc', '0.1.0'])
  })
})

describe('SSH 命令用在跑的那一版', () => {
  const exists = (files: string[]) => (file: string) => files.includes(file)

  it('current 已经是新版、账号进程还是旧版:换成旧版的可执行文件', () => {
    expect(chooseVersionBinary({ ownVersion: '0.2.140', runningVersion: '0.2.139', versionsDir: '/h/versions', exists: exists(['/h/versions/0.2.139/bin/gugu-server']), alreadySwitched: false })).toBe('/h/versions/0.2.139/bin/gugu-server')
  })

  it('版本一致 / 读不到 / 盘上没有那一版 / 已经换过一次:就用自己', () => {
    const base = { versionsDir: '/h/versions', exists: () => true, alreadySwitched: false }
    expect(chooseVersionBinary({ ...base, ownVersion: '0.2.140', runningVersion: '0.2.140' })).toBeNull()
    expect(chooseVersionBinary({ ...base, ownVersion: '0.2.140', runningVersion: null })).toBeNull()
    expect(chooseVersionBinary({ ...base, ownVersion: undefined, runningVersion: '0.2.139' })).toBeNull()
    expect(chooseVersionBinary({ ...base, ownVersion: '0.2.140', runningVersion: '0.2.139', exists: () => false })).toBeNull()
    expect(chooseVersionBinary({ ...base, ownVersion: '0.2.140', runningVersion: '0.2.139', alreadySwitched: true })).toBeNull()
    expect(chooseVersionBinary({ ...base, ownVersion: '0.2.140', runningVersion: '../../etc' })).toBeNull()
  })

  it('在跑的版本从进程环境读,读不到退回命令行里的 versions/<版本>/', () => {
    const read = (files: Record<string, string>) => (file: string) => files[file] ?? null
    expect(runningVersionOf(9, read({ '/proc/9/environ': 'A=1\0GUGU_TASK_HOST_VERSION=0.2.139\0B=2' }))).toBe('0.2.139')
    expect(runningVersionOf(9, read({ '/proc/9/cmdline': '/h/versions/0.2.138/node/bin/node\0/h/versions/0.2.138/app/dist-electron/server.js\0run-account' }))).toBe('0.2.138')
    expect(runningVersionOf(9, read({}))).toBeNull()
  })
})

describe('升级前自检', () => {
  it('每一项都跑、逐项报结果,任何一项失败整体不过', async () => {
    const results = await runChecks([
      { name: 'ok', run: () => undefined },
      { name: 'abi', run: () => { throw new Error('NODE_MODULE_VERSION 115 vs 127') } },
      { name: 'later', run: async () => undefined },
    ])
    expect(results).toEqual([
      { name: 'ok', ok: true },
      { name: 'abi', ok: false, error: 'NODE_MODULE_VERSION 115 vs 127' },
      { name: 'later', ok: true },
    ])
  })
})

describe('账号进程的内存设置', () => {
  it('Linux 上让 glibc 把大块临时内存用完即还(实测每个账号省约 130MB);用户自己设过不动;别的平台不设', () => {
    expect(accountProcessEnv({ PATH: '/bin' }, 'linux')).toMatchObject({ PATH: '/bin', MALLOC_MMAP_THRESHOLD_: '16384', GUGU_SERVER_WAIT_PID: '' })
    expect(accountProcessEnv({ MALLOC_MMAP_THRESHOLD_: '131072' }, 'linux').MALLOC_MMAP_THRESHOLD_).toBe('131072')
    expect(accountProcessEnv({}, 'darwin').MALLOC_MMAP_THRESHOLD_).toBeUndefined()
  })
})
