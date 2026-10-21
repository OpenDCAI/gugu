// 更新接线(apps/desktop/electron/update-flow.ts):检查失败与下载失败必须分开(复核 113 delta 3)。
//
// 假 updater 照 electron-updater 6.8.3 的时序:
// - checkForUpdates 查到新版 → 同步发 update-available,再 resolve;查失败 → 先发 'error',再 reject
//   (AppUpdater.js:264-273)。
// - downloadUpdate 下好 → 发 update-downloaded,再 resolve;下失败 → 先发 'error'(dispatchError),再 reject。
// 状态值用产品同一条 updateStateAdvances,安装交接用真的 createUpdateQuit,只把交接(handOff)记下来。
import { describe, expect, it } from 'vitest'
import { createUpdateFlow, type UpdateInfoLike, type UpdateStatus, type UpdateStatusPayload } from '../../../../apps/desktop/electron/update-flow'
import { createUpdateQuit } from '../../../../apps/desktop/electron/update-quit'
import { updateStateAdvances } from '../../../../apps/desktop/shared/update-policy'

type Deferred = { promise: Promise<unknown>; resolve: () => void; reject: (error: Error) => void }
function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<unknown>((res, rej) => { resolve = () => res(undefined); reject = rej })
  promise.catch(() => {}) // 拒绝由被测代码处理;这里只防未处理告警
  return { promise, resolve, reject }
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

function rig() {
  const listeners = new Map<string, Array<(arg?: unknown) => void>>()
  const on = (event: string) => (listener: (arg: never) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener as (arg?: unknown) => void])
  }
  const fire = (event: string, arg?: unknown) => { for (const l of listeners.get(event) ?? []) l(arg) }

  let feed: string | null = null // feed 上的最新版;null = 查不到(离线)
  let pendingDownload: Deferred | null = null
  const downloads: string[] = []
  const handOffs: string[] = []
  let status: UpdateStatus = 'idle'
  let stagedVersion: string | null = null
  const statuses: UpdateStatus[] = []

  // 与产品同一个入口(autoUpdater.checkForUpdates):按下安装和周期检查都走它。
  const checkForUpdates = async (): Promise<unknown> => {
    if (feed === null) {
      const error = new Error('net::ERR_INTERNET_DISCONNECTED')
      fire('error', error)
      throw error
    }
    fire('update-available', { version: feed } satisfies UpdateInfoLike)
    return {}
  }

  const updateQuit = createUpdateQuit({
    markQuitIntent: () => {},
    handOff: () => { handOffs.push(stagedVersion ?? 'none') },
    quitApp: () => {},
    logInfo: () => {}, logWarn: () => {}, logError: () => {},
  }, { schedule: () => ({ cancel: () => {} }), defer: (run) => run() })

  const flow = createUpdateFlow({
    updater: {
      onUpdateAvailable: on('update-available'),
      onUpdateNotAvailable: on('update-not-available'),
      onDownloadProgress: on('download-progress'),
      onUpdateDownloaded: on('update-downloaded'),
      onError: on('error'),
      checkForUpdates,
      downloadUpdate: () => {
        downloads.push(flow.lastUpdateInfo?.version ?? '?')
        pendingDownload ??= deferred()
        return pendingDownload.promise
      },
    },
    enabled: true,
    getStatus: () => status,
    emit: (payload: UpdateStatusPayload) => {
      if (!updateStateAdvances(status, payload.status)) return
      status = payload.status
      statuses.push(payload.status)
      if (payload.status === 'downloaded') stagedVersion = (payload.updateInfo as { version: string }).version
    },
    onReady: () => {},
    rejectTarget: () => false,
    dmg: { applies: () => false, start: () => {} },
    updateQuit,
    logInfo: () => {},
    logWarn: () => {},
  })

  return {
    flow,
    get status() { return status },
    get stagedVersion() { return stagedVersion },
    statuses,
    handOffs,
    downloads,
    setFeed: (version: string | null) => { feed = version },
    /** 周期检查(main.ts 的 checkForUpdates 包了一层 try/catch,失败只告警)。 */
    periodicCheck: async () => { await checkForUpdates().catch(() => {}); await flush() },
    finishDownload: async () => {
      const d = pendingDownload!; pendingDownload = null
      fire('update-downloaded'); d.resolve(); await flush()
    },
    failDownload: async (message = 'net::ERR_CONNECTION_RESET') => {
      const d = pendingDownload!; pendingDownload = null
      const error = new Error(message)
      fire('error', error); d.reject(error); await flush()
    },
    /** 用户按「重启更新」。 */
    clickInstall: async () => { await flow.install(); await flush() },
  }
}

/** 起点:V2 已经静默下好在等人按。 */
async function staged(version = '0.2.90-beta.2.1') {
  const r = rig()
  r.setFeed(version)
  await r.periodicCheck()
  await r.finishDownload()
  expect(r.status).toBe('downloaded')
  expect(r.stagedVersion).toBe(version)
  return r
}

describe('按下「重启更新」时查 feed 失败(离线)', () => {
  it('照样装手上那一份,交接恰好一次', async () => {
    const r = await staged()
    r.setFeed(null)
    await r.clickInstall()
    expect(r.handOffs).toEqual(['0.2.90-beta.2.1'])
    expect(r.status).toBe('downloaded') // 检查失败不改写「下好了」
  })
})

describe('按下后去下更新的一版', () => {
  it('feed 上有更新的 → 先下它,下好就装它(不是旧的那份)', async () => {
    const r = await staged()
    r.setFeed('0.2.90-beta.3.1')
    await r.clickInstall()
    expect(r.status).toBe('downloading')
    expect(r.handOffs).toEqual([])
    await r.finishDownload()
    expect(r.handOffs).toEqual(['0.2.90-beta.3.1'])
  })

  it('下载途中一次周期检查失败 → 那次下载下完照样按原意装(用户按过)', async () => {
    const r = await staged()
    r.setFeed('0.2.90-beta.3.1')
    await r.clickInstall()
    r.setFeed(null)
    await r.periodicCheck()
    expect(r.status).toBe('downloading') // 检查失败 ❌ 打断下载
    await r.finishDownload()
    expect(r.handOffs).toEqual(['0.2.90-beta.3.1'])
  })

  it('下载失败 → 不装、照实报错;以后静默下载下好也 ❌ 自己去装;再往后的静默失败照旧不打扰', async () => {
    const r = await staged()
    r.setFeed('0.2.90-beta.3.1')
    await r.clickInstall()
    await r.failDownload()
    expect(r.status).toBe('error') // 用户要的下载 ⇒ 横幅「更新失败 + 重试」
    expect(r.handOffs).toEqual([])

    r.setFeed('0.2.90-beta.4.1')
    await r.periodicCheck()
    await r.finishDownload()
    expect(r.status).toBe('downloaded')
    expect(r.handOffs).toEqual([]) // 装不装、何时装由用户决定

    r.setFeed('0.2.90-beta.5.1')
    await r.periodicCheck()
    await r.failDownload()
    expect(r.status).toBe('available') // @@@5576 静默失败退回「发现新版本」,❌ 弹错
    expect(r.handOffs).toEqual([])
  })
})

describe('没按过「重启更新」', () => {
  it('静默下载途中周期检查失败 → 下载照常下完,只是就绪,不装', async () => {
    const r = rig()
    r.setFeed('0.2.90-beta.2.1')
    await r.periodicCheck()
    expect(r.status).toBe('downloading')
    r.setFeed(null)
    await r.periodicCheck()
    expect(r.status).toBe('downloading')
    await r.finishDownload()
    expect(r.status).toBe('downloaded')
    expect(r.handOffs).toEqual([])
  })

  it('同一版下好之后,下一轮检查 ❌ 再下一遍', async () => {
    const r = await staged()
    await r.periodicCheck()
    expect(r.downloads).toEqual(['0.2.90-beta.2.1'])
    expect(r.status).toBe('downloaded')
  })
})
