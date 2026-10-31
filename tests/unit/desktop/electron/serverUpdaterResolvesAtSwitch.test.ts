import { createServerVersionLifecycle } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
/*
 * 守护进程自升级:切到哪一版在**切的那一刻**现取清单,❌ 用等空闲开始时取到的那一版。
 * 10-08 ThinkPad 实读:59.1 在 08:11 取到 62.1、等空闲 2 h 38 min,其间发布了 63.1;10:49 切到的仍是 62.1,
 * 起来 60 s 后再升 63.1 —— 一次换版,账号进程多重启一次。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../apps/desktop/electron/server/server-upgrade-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/electron/server/server-upgrade-guard')>()),
  // 看门狗是一个真的后台进程;这里只看「切到哪一版」。
  spawnUpgradeGuard: () => undefined,
}))

const { startServerUpdater } = await import('../../../../apps/desktop/electron/server/server-updater')

const SHA = 'a'.repeat(64)
let home: string
let published: string
const fetched: string[] = []
const savedEnv = { ...process.env }

function stage(version: string): void {
  fs.mkdirSync(path.join(home, 'versions', version, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(home, 'versions', version, 'bin', 'gugu-server'), '')
  fs.mkdirSync(path.join(home, 'versions', version, 'app'), { recursive: true })
}

beforeEach(() => {
  vi.useFakeTimers()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-server-updater-'))
  stage('0.2.53-beta.59.1')
  fs.symlinkSync('versions/0.2.53-beta.59.1', path.join(home, 'current'))
  process.env.GUGU_SERVER_HOME = home
  process.env.GUGU_TASK_HOST_APP_PATH = path.join(home, 'versions', '0.2.53-beta.59.1', 'app')
  process.env.GUGU_TASK_HOST_VERSION = '0.2.53-beta.59.1'
  process.env.GUGU_SERVER_SUPERVISED = '1'
  fetched.length = 0
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url)
    return new Response(`${published} ${SHA} https://example.invalid/${published}.tar.gz\n`)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  process.env = { ...savedEnv }
  fs.rmSync(home, { recursive: true, force: true })
})

function updater(isBusy: () => boolean) {
  const log = { info: vi.fn(), warn: vi.fn() }
  const shutdown = vi.fn()
  const stop = startServerUpdater({ lifecycle: createServerVersionLifecycle({ layout: { home, versions: path.join(home, 'versions'), version: '0.2.53-beta.59.1' } }), log, isBusy, shutdown, stateWriter: { set: () => {}, clear: () => {} } })
  return { log, shutdown, stop }
}

describe('server self-upgrade resolves its target at the moment it switches', () => {
  it('a newer version published while waiting for idle is the one switched to — one restart, not two', async () => {
    stage('0.2.53-beta.62.1')
    stage('0.2.53-beta.63.1')
    published = '0.2.53-beta.62.1'
    let busy = true
    const { log, shutdown, stop } = updater(() => busy)

    await vi.advanceTimersByTimeAsync(60_000) // 起动后第一次检查:62.1,忙 ⇒ 等
    expect(shutdown).not.toHaveBeenCalled()
    published = '0.2.53-beta.63.1' // 等的时候发了新版
    busy = false
    await vi.advanceTimersByTimeAsync(30_000) // 下一轮等空闲:空闲了

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith('没有 agent 在跑,切到新版本', { from: '0.2.53-beta.59.1', to: '0.2.53-beta.63.1' })
    expect(fs.readlinkSync(path.join(home, 'current'))).toBe(path.join('versions', '0.2.53-beta.63.1'))
    stop()
  })

  it('while still busy, the idle rounds do not fetch the manifest', async () => {
    stage('0.2.53-beta.62.1')
    published = '0.2.53-beta.62.1'
    const { shutdown, stop } = updater(() => true)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetched).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5 * 30_000)
    expect(fetched).toHaveLength(1)
    expect(shutdown).not.toHaveBeenCalled()
    stop()
  })

  it('a failed manifest fetch on an idle round keeps waiting instead of dropping the wait until the next scheduled check', async () => {
    stage('0.2.53-beta.62.1')
    published = '0.2.53-beta.62.1'
    let busy = true
    const { shutdown, stop } = updater(() => busy)
    await vi.advanceTimersByTimeAsync(60_000)
    busy = false
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(shutdown).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', async () => new Response(`${published} ${SHA} https://example.invalid/x.tar.gz\n`))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(shutdown).toHaveBeenCalledTimes(1)
    stop()
  })

  it('a version published after start-up is found within half an hour, not 6 hours', async () => {
    stage('0.2.53-beta.62.1')
    published = '0.2.53-beta.59.1' // 起来时还是自己这版
    const { shutdown, stop } = updater(() => false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(shutdown).not.toHaveBeenCalled()
    published = '0.2.53-beta.62.1'
    await vi.advanceTimersByTimeAsync(28 * 60_000) // 起动后 29 min:还没到下一轮
    expect(fetched).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetched).toHaveLength(2)
    expect(shutdown).toHaveBeenCalledTimes(1)
    stop()
  })
})
