/**
 * 主窗口的渲染进程没了(崩溃、内存耗尽被杀、被系统杀掉)以后怎么办。
 *
 * 不接这个事件时的样子(2026-10-14 owner 的 Beta 实测):窗口一片白,日志里一个字都没有 —— 原因只在 macOS
 * 的崩溃报告里(那次是图片解码申请内存失败,TerminateBecauseOutOfMemory)。而这个渲染进程不只是界面:
 * 它握着登录会话,本机 agent 的令牌经它签发(main.ts @@@renderer-is-auth-server),它不在,agent 的令牌请求
 * 也跟着超时。用户只能自己退出重开。
 *
 * 所以:说出来(原因、退出码),并把窗口重新载入。连着崩就停 —— 一份一启动就崩的页面会被无限重载成闪烁,
 * 那时当面说清楚,让人选重新载入还是退出。
 */

/** 多长时间里的崩溃算「连着崩」 */
export const RENDERER_CRASH_WINDOW_MS = 5 * 60_000
/** 这段时间里第几次崩溃时不再自动重新载入 */
export const RENDERER_CRASH_LIMIT = 3

export type RendererGoneDecision = 'ignore' | 'reload' | 'give-up'

/**
 * @param reason Electron `render-process-gone` 的 details.reason
 * @param recent 之前每次崩溃的时刻(ms),只认窗口期内的
 * @returns 这次怎么办,以及把这次算进去之后的崩溃时刻表
 */
export function decideRendererGone(
  reason: string,
  recent: readonly number[],
  now: number,
): { decision: RendererGoneDecision; recent: number[] } {
  const kept = recent.filter((at) => now - at < RENDERER_CRASH_WINDOW_MS)
  // clean-exit:页面是被正常收掉的(退出、换掉 webContents),不是崩溃
  if (reason === 'clean-exit') return { decision: 'ignore', recent: kept }
  const next = [...kept, now]
  return { decision: next.length >= RENDERER_CRASH_LIMIT ? 'give-up' : 'reload', recent: next }
}

/** 连着崩到上限时当面问的结果;no-window = 窗口已经没了,问不了 */
export type CrashDialogChoice = 'reload' | 'quit' | 'no-window'

export interface MainRendererGoneDeps {
  /** 应用正在退出:这时没了的渲染进程是被收掉的 */
  isQuitting: () => boolean
  now: () => number
  /** 把主窗口的页面重新载入 */
  reload: () => void
  /** 连着崩到上限:当面问「重新载入 / 退出」 */
  ask: (count: number) => Promise<CrashDialogChoice>
  quit: () => void
  log: {
    error: (fields: Record<string, unknown>, msg: string) => void
    info: (fields: Record<string, unknown>, msg: string) => void
  }
}

/**
 * 主窗口渲染进程没了的处理。崩溃时刻表在这里,动作由 main.ts 注入。
 * @returns render-process-gone 的处理函数(reason / exitCode 取自 Electron 的 details)
 */
export function createMainRendererGoneHandler(deps: MainRendererGoneDeps) {
  let recent: number[] = []
  return async (reason: string, exitCode: number): Promise<void> => {
    if (deps.isQuitting()) return
    const out = decideRendererGone(reason, recent, deps.now())
    recent = out.recent
    if (out.decision === 'ignore') return
    deps.log.error(
      { reason, exitCode, decision: out.decision, crashesInWindow: recent.length },
      '主窗口渲染进程没了',
    )
    if (out.decision === 'reload') {
      deps.reload()
      return
    }
    const count = recent.length
    const choice = await deps.ask(count)
    // 问的这段时间里别处开始退出了(托盘退出、更新重启):对话框是被退出收掉的,❌ 当成用户的回答,❌ 停机中途再 quit 一次
    if (deps.isQuitting() || choice === 'no-window') return
    if (choice === 'reload') {
      deps.log.info({ count }, '连着崩之后,用户选了重新载入')
      recent = []
      deps.reload()
      return
    }
    deps.log.info({ count }, '连着崩之后,用户选了退出')
    deps.quit()
  }
}

/**
 * 主窗口渲染进程卡住了(没死、只是不回应)。Electron 在它约几秒不回应时发 `unresponsive`,恢复时发 `responsive`。
 *
 * 不接这两个事件时的样子(2026-10-25 owner 的 Windows Beta):界面冻了 11 分钟,主进程照常写日志、照常退出,
 * 界面那一侧一个字都没有 —— 事后分不出是界面卡住、主进程卡住还是 GPU 出事。所以只记下来:什么时候开始、
 * 卡了多久、当时是哪个渲染进程、GPU 进程在不在。❌ 不替人做决定(不重载、不弹窗):卡住的页面多半自己会回来。
 */
export interface MainRendererResponsivenessDeps {
  now: () => number
  /** 主窗口渲染进程的 pid(`webContents.getOSProcessId()`) */
  rendererPid: () => number
  /** GPU 进程此刻的样子(`app.getAppMetrics()` 里 type 为 GPU 的那一行);没有 = null */
  gpuProcess: () => { pid: number; workingSetKb?: number; cpuPercent?: number } | null
  log: {
    warn: (fields: Record<string, unknown>, msg: string) => void
    info: (fields: Record<string, unknown>, msg: string) => void
  }
}

/** @returns 挂到主窗口 webContents 的 `unresponsive` / `responsive` 上的两个处理函数 */
export function createMainRendererResponsivenessLog(deps: MainRendererResponsivenessDeps) {
  let since: number | null = null
  const state = () => ({ rendererPid: deps.rendererPid(), gpuProcess: deps.gpuProcess() })
  return {
    onUnresponsive(): void {
      if (since !== null) return
      since = deps.now()
      deps.log.warn({ since: new Date(since).toISOString(), ...state() }, '主窗口渲染进程不回应')
    },
    onResponsive(): void {
      if (since === null) return
      const durationMs = deps.now() - since
      deps.log.info({ since: new Date(since).toISOString(), durationMs, ...state() }, '主窗口渲染进程恢复回应')
      since = null
    },
  }
}
