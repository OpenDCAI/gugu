/**
 * 「按下更新 → 应用退出 → Squirrel 换包 → 自己开回来」这条路上,难的不是任何一步,是**顺序**。
 *
 * @@@5793 owner 2026-09-17 实测:按下到界面能用 **37 秒**,其中 **25 秒是两道超时兜底在空等**,
 * 而且前后两次更新、两道兜底都**全额吃满**(20.000s / 5.000s,整秒到毫秒),
 * 说明 #5747 装兜底时假定的那条「正常路径」一次都没有走通过 —— 保险从上线那天起就一直在承重。
 *
 * 真因是一处顺序错。Electron 原生 `autoUpdater.quitAndInstall()` 的契约写得很清楚:
 * 「先关掉所有窗口,全部关上之后自动调 `app.quit()`」(electron.d.ts:2107)。
 * 而 macOS 上主窗口的 close 被我们拦下来改成了收进托盘(main.ts 里 `!isQuitting` 那一支)——
 * 于是窗口永远关不上,「全部关上之后」永远不来,`app.quit()` 永远不调,进程就那么活着,
 * 直到 20 秒看门狗替它退。ShipIt 那边从收到安装请求起就在等我们退
 * (实测:我们一退,它 **91 毫秒**后就开装)。两边互等,各等到自己的闹钟响。
 *
 * ⇒ 按下更新就是一次**真退出**。退出意图必须在把包交给 Squirrel **之前**立起来,
 *   立起来之后关窗 → `app.quit()` → `before-quit` 停机 → 退出,一路顺下去。
 *   看门狗留着,但它的使命变成「真的出事时才响」—— 判据是正常路径下它一次都不许触发。
 */

/** 看门狗:库那条路若卡在「等一个不会再来的事件」上,到点我们自己走优雅停机退出。 */
export const INSTALL_WATCHDOG_MS = 20_000

export interface UpdateQuitHost {
  /**
   * 立起「这次是真退出」。必须先于 handOff —— 顺序反过来就是 #5793 那 20 秒。
   * 对应 main.ts 里的 `isQuitting`,也就是 Cmd+Q / 托盘退出走的同一个开关。
   */
  markQuitIntent: () => void
  /** 把包交给 Squirrel(electron-updater 的 quitAndInstall)。 */
  handOff: () => void
  /** 看门狗兜底:自己走优雅退出(`app.quit()`),❌ 不是硬杀 —— 硬杀会跳过 Squirrel 的装完重开。 */
  quitApp: () => void
  logInfo: (detail: Record<string, unknown>, message: string) => void
  logWarn: (detail: Record<string, unknown>, message: string) => void
  logError: (detail: Record<string, unknown>, message: string) => void
}

export interface UpdateQuitTimer {
  cancel: () => void
}

export interface UpdateQuitOptions {
  watchdogMs?: number
  /** 注入定时器,测试里不必真等 20 秒。 */
  schedule?: (run: () => void, ms: number) => UpdateQuitTimer
  /** 注入「下一拍再执行」,默认 setImmediate:让按下这一帧先画完。 */
  defer?: (run: () => void) => void
}

export interface UpdateQuit {
  /** 用户按下「立即重启更新」。重复按下返回 false(且不重复交接)。 */
  begin: (detail?: Record<string, unknown>) => boolean
  /**
   * 按下「重启更新」时 feed 上还有更新的一版,先去下它:记下「下好就装」。只用一次 ——
   * 那次下载成功由 `downloaded` 消费,失败由 `downloadFailed` 作废;❌ 留到以后某次静默下载下好时
   * 把人从正在做的事里拽出去装(装不装、何时装由用户决定)。
   */
  installAfterDownload: () => void
  /** 下好了:有在等的「下好就装」就消费掉并开始安装,返回是否开始。 */
  downloaded: (detail?: Record<string, unknown>) => boolean
  /** 下载失败:这一次「下好就装」作废。返回它此前是否在等(在等 = 这次下载是用户要的)。 */
  downloadFailed: () => boolean
  /** 停机已经开始 —— 看门狗的使命到此结束,别在停机中途再捅一次 `app.quit()`。 */
  noteShutdownStarted: () => void
  /** 这次退出是不是为了更新(退出的最后一步据此分流)。 */
  readonly forUpdate: boolean
}

function defaultSchedule(run: () => void, ms: number): UpdateQuitTimer {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export function createUpdateQuit(host: UpdateQuitHost, options: UpdateQuitOptions = {}): UpdateQuit {
  const watchdogMs = options.watchdogMs ?? INSTALL_WATCHDOG_MS
  const schedule = options.schedule ?? defaultSchedule
  const defer = options.defer ?? ((run: () => void) => { setImmediate(run) })

  let started = false
  let installPending = false
  let watchdog: UpdateQuitTimer | null = null

  const stopWatchdog = (): void => {
    watchdog?.cancel()
    watchdog = null
  }

  const begin = (detail: Record<string, unknown> = {}): boolean => {
    if (started) {
      host.logWarn(detail, '[updater] 安装已在进行中,忽略这次重复按下')
      return false
    }
    started = true
    // 这一行就是 #5793 的全部:退出意图必须**先**立起来,否则下面交出去之后,
    // Squirrel 关窗会被「收进托盘」吃掉,app.quit() 永远不来。
    host.markQuitIntent()
    host.logInfo(detail, '[updater] 用户按下安装 —— 交给 Squirrel')
    defer(() => host.handOff())
    watchdog = schedule(() => {
      watchdog = null
      host.logError(
        detail,
        '[updater] quitAndInstall 超时未能终结本进程 —— 转为自行停机退出(包已备好,退出即安装)',
      )
      host.quitApp()
    }, watchdogMs)
    return true
  }

  return {
    get forUpdate(): boolean {
      return started
    },

    begin,

    installAfterDownload(): void {
      installPending = true
    },

    downloaded(detail: Record<string, unknown> = {}): boolean {
      if (!installPending) return false
      installPending = false
      return begin(detail)
    },

    downloadFailed(): boolean {
      const wasPending = installPending
      installPending = false
      return wasPending
    },

    noteShutdownStarted(): void {
      stopWatchdog()
    },
  }
}
