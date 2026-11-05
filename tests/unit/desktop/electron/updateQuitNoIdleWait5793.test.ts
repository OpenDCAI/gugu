// @@@5793 owner 2026-09-17 实测:按下「立即重启更新」到界面能用 37 秒,其中 25 秒是两道超时兜底
// 在空等,而且前后两次更新、两道兜底都**全额吃满**(20.000s / 5.000s,整秒到毫秒)。
//
// 真因是顺序:Electron 原生 autoUpdater.quitAndInstall() 的契约是「先关掉所有窗口,全部关上之后
// 自动调 app.quit()」(electron.d.ts:2107);而 macOS 上主窗口的 close 被我们拦成了「收进托盘」,
// 于是窗口永远关不上、app.quit() 永远不来、进程就那么活着,直到看门狗替它退。
//
// 下面第一组测试把这三方(关窗拦截 / Electron 的契约 / 我们的交接)照原样搭出来跑一遍:
// **不先立退出意图就交接,进程退不掉、只能靠看门狗**;先立了就一路顺下去、看门狗一次都不响。
// 这一组在修复前必红、修复后全绿。
import { describe, expect, it, vi } from 'vitest'
import { createSquirrelHandoff, createUpdateQuit, type UpdateQuitTimer } from '../../../../apps/desktop/electron/update-quit'

/** 把定时器攥在手里:测试不必真等 20 秒,也能断言「到点了它响不响」。 */
function fakeClock() {
  const pending: { run: () => void; ms: number; cancelled: boolean }[] = []
  return {
    schedule: (run: () => void, ms: number): UpdateQuitTimer => {
      const entry = { run, ms, cancelled: false }
      pending.push(entry)
      return { cancel: () => { entry.cancelled = true } }
    },
    /** 让所有还活着的定时器到点。返回真正响了几个。 */
    fire: (): number => {
      let fired = 0
      for (const entry of pending) {
        if (entry.cancelled) continue
        entry.cancelled = true
        fired += 1
        entry.run()
      }
      return fired
    },
    get scheduled() { return pending.length },
  }
}

/**
 * 真机上那三方的最小模型。
 * - 关窗拦截:main.ts 的 `if (!isQuitting) { preventDefault(); hide() }`
 * - Electron 的契约:关掉所有窗口,**全部关上之后**才 app.quit()(electron.d.ts:2107)
 * - 我们的交接:createUpdateQuit
 */
function simulateMacInstall(options: { markQuitIntentBeforeHandOff: boolean }) {
  const clock = fakeClock()
  const calls: string[] = []
  let isQuitting = false
  let windowOpen = true
  let appQuitCalls = 0

  const closeWindowLikeMainTs = (): void => {
    // macOS 上不是真关,是收进托盘 —— 除非退出意图已经立起来了。
    if (!isQuitting) return
    windowOpen = false
  }
  const nativeQuitAndInstallContract = (): void => {
    calls.push('handOff')
    closeWindowLikeMainTs()
    if (!windowOpen) appQuitCalls += 1
  }

  const quit = createUpdateQuit({
    markQuitIntent: () => {
      calls.push('markQuitIntent')
      // 只有开关真被打开,拦截才会放行;这里刻意做成可关掉,好让「修复前」也能跑出来。
      if (options.markQuitIntentBeforeHandOff) isQuitting = true
    },
    handOff: nativeQuitAndInstallContract,
    quitApp: () => {
      calls.push('watchdogQuitApp')
      appQuitCalls += 1
    },
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  }, {
    schedule: clock.schedule,
    defer: (run) => run(),
  })

  return {
    quit,
    clock,
    calls,
    get appQuitCalls() { return appQuitCalls },
    get windowOpen() { return windowOpen },
  }
}

describe('#5793 更新退出:不许靠超时兜底把进程拖走', () => {
  it('先立退出意图 —— 窗口真关上,app.quit() 当场就来,看门狗一次都不响', () => {
    const run = simulateMacInstall({ markQuitIntentBeforeHandOff: true })

    expect(run.quit.begin()).toBe(true)

    expect(run.windowOpen).toBe(false)
    expect(run.appQuitCalls).toBe(1)
    // 顺序就是这条修复的全部:立意图必须排在交接前面。
    expect(run.calls).toEqual(['markQuitIntent', 'handOff'])

    // 停机一开始就撤看门狗,之后到点也不该再捅一次 app.quit()。
    run.quit.noteShutdownStarted()
    expect(run.clock.fire()).toBe(0)
    expect(run.appQuitCalls).toBe(1)
  })

  it('不立退出意图(修复前的样子)—— 关窗被托盘吃掉,只能等看门狗,这就是那 20 秒', () => {
    const run = simulateMacInstall({ markQuitIntentBeforeHandOff: false })

    run.quit.begin()

    // 窗口还开着 = Electron 那句「全部关上之后」永远不来 = 进程不退。
    expect(run.windowOpen).toBe(true)
    expect(run.appQuitCalls).toBe(0)

    // 唯一能把它退掉的,是到点的看门狗 —— owner 两次实测量到的正是这一路。
    expect(run.clock.fire()).toBe(1)
    expect(run.calls).toContain('watchdogQuitApp')
    expect(run.appQuitCalls).toBe(1)
  })

  it('看门狗走的是优雅退出,❌ 不是硬杀 —— 硬杀会连 Squirrel 的装完重开一起跳过', () => {
    const quitApp = vi.fn()
    const clock = fakeClock()
    const quit = createUpdateQuit(
      { markQuitIntent: vi.fn(), handOff: vi.fn(), quitApp, logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() },
      { schedule: clock.schedule, defer: (run) => run() },
    )
    quit.begin()
    clock.fire()
    expect(quitApp).toHaveBeenCalledTimes(1)
  })

  it('重复按下只交接一次,也只挂一个看门狗', () => {
    const handOff = vi.fn()
    const logWarn = vi.fn()
    const clock = fakeClock()
    const quit = createUpdateQuit(
      { markQuitIntent: vi.fn(), handOff, quitApp: vi.fn(), logInfo: vi.fn(), logWarn, logError: vi.fn() },
      { schedule: clock.schedule, defer: (run) => run() },
    )

    expect(quit.begin()).toBe(true)
    expect(quit.begin()).toBe(false)
    expect(quit.begin()).toBe(false)

    expect(handOff).toHaveBeenCalledTimes(1)
    expect(clock.scheduled).toBe(1)
    expect(logWarn).toHaveBeenCalledTimes(2)
  })

  it('forUpdate 就是退出最后一步的分流依据:按下之前 false,之后 true', () => {
    const clock = fakeClock()
    const quit = createUpdateQuit(
      { markQuitIntent: vi.fn(), handOff: vi.fn(), quitApp: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() },
      { schedule: clock.schedule, defer: (run) => run() },
    )
    expect(quit.forUpdate).toBe(false)
    quit.begin()
    expect(quit.forUpdate).toBe(true)
  })
})

// 退出的最后一步(before-quit 停机之后):包已备好就不该再有交接余量。判的是「有没有等」,不是「等多久」——
// 把 5 秒改小只是把空等改短,方向仍然是错的。
describe('#5793 包已备好就不该再有交接余量', () => {
  class Exited extends Error {}
  function handoff(platform: NodeJS.Platform, options: { quitAndInstall?: () => void } = {}) {
    const clock = fakeClock()
    let staged: (() => void) | null = null
    const quitAndInstall = vi.fn(options.quitAndInstall ?? (() => {}))
    const h = createSquirrelHandoff({
      platform, onStaged: (listener) => { staged = listener }, quitAndInstall,
      logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
    }, { schedule: clock.schedule })
    const exits: number[] = []
    // reallyExit 不回来:替身抛出,证明它之后的代码一行都没跑。
    const hardExit = (): never => { exits.push(1); throw new Exited() }
    const exit = (forUpdate: boolean) => { try { h.exit(forUpdate, hardExit) } catch (error) { if (!(error instanceof Exited)) throw error } }
    return { clock, quitAndInstall, exits, exit, stage: () => staged?.() }
  }

  it('包已备好(原生 update-downloaded 来过):交给 Squirrel 之后当场退,不排任何余量', () => {
    const t = handoff('darwin')
    t.stage()
    t.exit(true)
    expect(t.quitAndInstall).toHaveBeenCalledOnce()
    expect(t.exits).toHaveLength(1)
    expect(t.clock.scheduled, '没有东西可等').toBe(0)
  })

  it('包还没备好:交接之后留余量,到点才硬退兜底', () => {
    const t = handoff('darwin')
    t.exit(true)
    expect(t.quitAndInstall).toHaveBeenCalledOnce()
    expect(t.exits).toHaveLength(0)
    expect(t.clock.scheduled).toBe(1)
    expect(() => t.clock.fire(), 'the grace timer ends in a hard exit').toThrow(Exited)
    expect(t.exits).toHaveLength(1)
  })

  it('交接本身抛了:硬退,不排余量', () => {
    const t = handoff('darwin', { quitAndInstall: () => { throw new Error('No update available') } })
    t.exit(true)
    expect(t.exits).toHaveLength(1)
    expect(t.clock.scheduled).toBe(0)
  })

  it.each([['不是为更新而退', 'darwin', false], ['Windows 上安装器早已起好', 'win32', true], ['Linux', 'linux', true]] as const)('%s:直接硬退,不碰原生 autoUpdater', (_label, platform, forUpdate) => {
    const t = handoff(platform)
    t.stage()
    t.exit(forUpdate)
    expect(t.quitAndInstall).not.toHaveBeenCalled()
    expect(t.exits).toHaveLength(1)
    expect(t.clock.scheduled).toBe(0)
  })
})

// 按下「重启更新」时 feed 上有更新的一版,宿主先去下它,「下好就装」只用一次(复核 113 delta 2)。
// 留着不清的话:下载失败 → 用户按「稍后」→ 半小时后某次静默下载下好 → 进程当场退出去装,
// 违背「装不装、何时装由用户决定」。
describe('下好就装:只用一次', () => {
  function quit() {
    const handOffs: number[] = []
    const q = createUpdateQuit({
      markQuitIntent: () => {},
      handOff: () => { handOffs.push(1) },
      quitApp: () => {},
      logInfo: () => {}, logWarn: () => {}, logError: () => {},
    }, { schedule: fakeClock().schedule, defer: (run) => run() })
    return { q, handOffs }
  }

  it('按下后那次下载下好 → 装一次', () => {
    const { q, handOffs } = quit()
    q.installAfterDownload()
    expect(q.downloaded()).toBe(true)
    expect(handOffs).toHaveLength(1)
    expect(q.forUpdate).toBe(true)
  })

  it('那次下载失败之后,以后的静默下载下好 ❌ 自己去装', () => {
    const { q, handOffs } = quit()
    q.installAfterDownload()
    expect(q.downloadFailed()).toBe(true) // 这次失败是用户要的下载 ⇒ 照实报错
    expect(q.downloaded()).toBe(false)    // 半小时后静默下载下好
    expect(handOffs).toHaveLength(0)
    expect(q.forUpdate).toBe(false)
    expect(q.downloadFailed()).toBe(false) // 之后的静默失败照旧不打扰(@@@5576)
  })

  it('没按过「重启更新」:静默下载下好只是就绪,不装', () => {
    const { q, handOffs } = quit()
    expect(q.downloaded()).toBe(false)
    expect(handOffs).toHaveLength(0)
  })
})

