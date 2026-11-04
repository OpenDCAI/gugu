import { createServerVersionLifecycle } from '../../../../apps/desktop/electron/server/server-version-lifecycle'
import { markServerReady, readPendingVerify } from '../../../../apps/desktop/electron/server/server-startup'
import { VERSION_RESTART_RPC, VERSION_RETRY_RPC } from '../../../../packages/core/src/cloud/serverMachineHealth'
/*
 * 守护进程自升级:切到哪一版在**切的那一刻**现取清单,❌ 用等空闲开始时取到的那一版。
 * 10-08 ThinkPad 实读:59.1 在 08:11 取到 62.1、等空闲 2 h 38 min,其间发布了 63.1;10:49 切到的仍是 62.1,
 * 起来 60 s 后再升 63.1 —— 一次换版,账号进程多重启一次。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { serverUpdateRpcHandlers, startServerUpdater } = await import('../../../../apps/desktop/electron/server/server-updater')

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
  fs.writeFileSync(path.join(home, 'channel'), 'stable\n')
  fetched.length = 0
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url)
    const version = url.match(/\/(0\.2\.53-beta\.[0-9]+\.1)\//)?.[1] ?? published
    return new Response(`${version} ${SHA} https://example.invalid/${version}.tar.gz\n`)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  process.env = { ...savedEnv }
  fs.rmSync(home, { recursive: true, force: true })
})

function updater(isBusy: () => boolean, verifyBoot: (binary: string) => Promise<void> = async () => undefined) {
  const log = { info: vi.fn(), warn: vi.fn() }
  const shutdown = vi.fn()
  const stop = startServerUpdater({ lifecycle: createServerVersionLifecycle({ verifyBoot, layout: { home, versions: path.join(home, 'versions'), version: '0.2.53-beta.59.1' } }), log, isBusy, shutdown })
  return { log, shutdown, stop: stop.dispose, control: stop }
}

describe('server self-upgrade resolves its target at the moment it switches', () => {
  it('keeps a prepared target and confirmation after a regular feed refresh fails', async () => {
    published = '0.2.53-beta.62.1'; stage(published)
    const { control, shutdown, stop } = updater(() => true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'data/server-update.json'), 'utf8')).state).toBe('ready')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('release feed offline')))
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'data/server-update.json'), 'utf8'))).toMatchObject({ state: 'ready', version: published })
    expect(control.restartConfirmed(published, true)).toEqual(expect.any(Number))
    await vi.advanceTimersByTimeAsync(0)
    expect(shutdown).toHaveBeenCalledOnce()
    stop()
  })
  it('reads the current version-switch activity without scheduling an update', async () => {
    const isBusy = vi.fn(() => true)
    const { control, shutdown, stop } = updater(isBusy)
    let count = 2
    const activity = vi.fn(() => ({ busy: count > 0, busyAgents: count }))
    const runtime = { isBusy, shutdown, versionSwitchActivity: activity }
    control.bindRuntime(runtime)
    const handler = serverUpdateRpcHandlers()['server.versionMatch.activity']
    expect(handler).toBeTypeOf('function')
    expect(await handler({}, {} as never)).toEqual({ result: { busyAgents: 2 } })
    count = 0
    expect(await handler({}, {} as never)).toEqual({ result: { busyAgents: 0 } })
    expect(activity).toHaveBeenCalledTimes(2)
    expect(isBusy).not.toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
    expect(readPendingVerify(home)).toBeNull()
    stop()
  })

  it('refuses a confirmed bad target and does not republish it as restartable on the next check', async () => {
    published = '0.2.53-beta.62.1'; stage(published)
    const { control, shutdown, stop } = updater(() => true)
    await vi.advanceTimersByTimeAsync(60_000)
    fs.writeFileSync(path.join(home, 'data/bad-versions.json'), JSON.stringify({ [published]: Date.now() }))
    fs.writeFileSync(path.join(home, 'data/server-update.json'), JSON.stringify({ state: 'failed', version: published,
      cause: 'boot', at: Date.now(), lastOutcome: { kind: 'rolledBack', bad: published, back: '0.2.53-beta.59.1', at: Date.now(), request: 42 } }))
    expect(await serverUpdateRpcHandlers()[VERSION_RESTART_RPC]({ version: published, confirmed: true }, {} as never))
      .toMatchObject({ error: { code: 'invalid_payload' } })
    expect(control.retryWhenIdle()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(shutdown).not.toHaveBeenCalled()
    expect(readPendingVerify(home)).toBeNull()
    expect(fs.readlinkSync(path.join(home, 'current'))).toBe('versions/0.2.53-beta.59.1')
    expect(JSON.parse(fs.readFileSync(path.join(home, 'data/server-update.json'), 'utf8')))
      .toMatchObject({ state: 'idle', version: '0.2.53-beta.59.1', lastOutcome: { kind: 'rolledBack', request: 42 } })
    stop()
  })

  it('still retries a boot failure that has not been marked bad', async () => {
    published = '0.2.53-beta.62.1'; stage(published)
    const verify = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('temporary boot environment failure'))
    const { control, shutdown, stop } = updater(() => false, verify)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(shutdown).not.toHaveBeenCalled()
    expect(control.retryWhenIdle()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(shutdown).toHaveBeenCalledOnce()
    stop()
  })

  it('pauses outgoing reports before committing a switch, and resumes them if activation fails', async () => {
    stage('0.2.53-beta.62.1')
    published = '0.2.53-beta.62.1'
    const lifecycle = createServerVersionLifecycle({ verifyBoot: async () => undefined,
      layout: { home, versions: path.join(home, 'versions'), version: '0.2.53-beta.59.1' } })
    const resume = vi.fn()
    const beforeSwitch = vi.fn(() => resume)
    vi.spyOn(lifecycle, 'switchSupervisor').mockImplementation(() => {
      expect(beforeSwitch).toHaveBeenCalledOnce()
      throw new Error('current could not be replaced')
    })
    const control = startServerUpdater({ lifecycle, isBusy: () => false, beforeSwitch,
      shutdown: vi.fn(), log: { info: vi.fn(), warn: vi.fn() } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(resume).toHaveBeenCalledOnce()
    expect(JSON.parse(fs.readFileSync(path.join(home, 'data/server-update.json'), 'utf8'))).toMatchObject({ state: 'failed' })
    control.dispose()
  })
  it('a newer version published while waiting for idle is the one switched to — one restart, not two', async () => {
    stage('0.2.53-beta.62.1')
    stage('0.2.53-beta.63.1')
    published = '0.2.53-beta.62.1'
    let busy = true
    const { shutdown, stop } = updater(() => busy)

    await vi.advanceTimersByTimeAsync(60_000) // 起动后第一次检查:62.1,忙 ⇒ 等
    expect(shutdown).not.toHaveBeenCalled()
    published = '0.2.53-beta.63.1' // 等的时候发了新版
    busy = false
    await vi.advanceTimersByTimeAsync(30_000) // 下一轮等空闲:空闲了

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(readPendingVerify(home)).toMatchObject({ from: '0.2.53-beta.59.1', to: '0.2.53-beta.63.1', attempts: 0 })
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

  it('binds a busy restart to its acknowledged ready target even after the channel advances', async () => {
    stage('0.2.53-beta.62.1'); stage('0.2.53-beta.63.1')
    published = '0.2.53-beta.62.1'
    const { control, shutdown, stop } = updater(() => true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(control.restartConfirmed('0.2.53-beta.63.1', true)).toBe(false)
    expect(control.restartConfirmed(published, false)).toBe(false)
    const handler = serverUpdateRpcHandlers()[VERSION_RESTART_RPC]
    const result = await handler({ version: published, confirmed: true }, {} as never)
    const at = (result as { result: { at: number } }).result.at
    published = '0.2.53-beta.63.1'
    await vi.advanceTimersByTimeAsync(0)
    expect(shutdown).toHaveBeenCalledOnce()
    expect(readPendingVerify(home)).toMatchObject({ from: '0.2.53-beta.59.1', to: '0.2.53-beta.62.1', attempts: 0, request: at })
    expect(fs.readlinkSync(path.join(home, 'current'))).toBe('versions/0.2.53-beta.62.1')
    // Only the target process can acknowledge that it reached readiness.
    markServerReady(home)
    expect(readPendingVerify(home)).not.toBeNull()
    process.env.GUGU_TASK_HOST_VERSION = '0.2.53-beta.62.1'
    markServerReady(home)
    const state = JSON.parse(fs.readFileSync(path.join(home, 'data/server-update.json'), 'utf8'))
    expect(state).toMatchObject({ state: 'idle', lastOutcome: { kind: 'switched', target: '0.2.53-beta.62.1', request: at } })
    expect(fs.existsSync(path.join(home, 'accounts'))).toBe(false)
    stop()
  })

  it('an idle-only RPC never grants permission to interrupt busy work', async () => {
    stage('0.2.53-beta.62.1'); published = '0.2.53-beta.62.1'
    const { shutdown, stop } = updater(() => true)
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await serverUpdateRpcHandlers()[VERSION_RETRY_RPC]({ confirmed: true }, {} as never)
    expect(result).toMatchObject({ result: { requested: true } })
    await vi.advanceTimersByTimeAsync(0)
    expect(shutdown).not.toHaveBeenCalled()
    expect(readPendingVerify(home)).toBeNull()
    stop()
  })

  it('a cooling failed target does not hide a later release', async () => {
    stage('0.2.53-beta.62.1'); stage('0.2.53-beta.63.1'); published = '0.2.53-beta.62.1'
    const verify = vi.fn(async (binary: string) => {
      if (binary.includes('beta.62.1')) throw new Error('boot fixture rejected')
    })
    const { shutdown, stop } = updater(() => false, verify)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(shutdown).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(path.join(home, 'data/server-update.json'), 'utf8'))).toMatchObject({ state: 'failed', cause: 'boot' })
    published = '0.2.53-beta.63.1'
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(shutdown).toHaveBeenCalledOnce()
    expect(readPendingVerify(home)?.to).toBe(published)
    stop()
  })
})
