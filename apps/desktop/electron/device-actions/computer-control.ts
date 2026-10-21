/**
 * #7199 电脑控制的「正在操作 · 停止」小条与人接管 —— 按 App 算,不按整台电脑算(owner 10-15:「不接管电脑,只接管这个 App」):
 *
 * - agent 动某个 App(看也算:人该知道有人在看它),屏幕底部中间浮一枚小条「<谁> 正在操作「<App>」 · 停止」;
 *   没指定 App 的动作(列 App、读屏幕大小、整屏截图、挪 agent 自己的鼠标)是「<谁> 正在查看这台电脑」,
 *   它不盖掉已经亮着的条(正在操作的 App、或人刚停下的 App)。最后一个动作做完半分钟没有下一个,小条收起。
 * - 人照常用电脑 —— 包括点进、挪动 agent 正在操作的那个 App —— 都不打断它:cua-driver 在后台做事,不碰人的真鼠标和前台。
 * - 「停止」只停小条上的那个 App:它在途的动作中断,之后 agent 再动这个 App 一律拒,直到人点「让它继续」;别的 App 照常。
 *   小条上是「正在查看这台电脑」时按停止 = 整个电脑控制停下。
 */

/** 小条本身(main 用一个不抢焦点、不进截图的置顶小窗实现;测试换成记录器)。没有 app = 没指定 App(查看这台电脑);app 没 name = 认不出名字的 App。 */
export interface ComputerControlView {
  show(view: { state: 'driving' | 'paused'; callerName?: string; app?: { name?: string } }): void
  hide(): void
}

/** 一个动作:针对哪个 App(pid;不指定 App 的动作没有)。 */
export interface ComputerCall {
  callerName?: string
  pid?: number
  appName?: string
}

export type ComputerCallHandle = { refused: string } | { signal: AbortSignal; end(): void }

export interface ComputerControl {
  /** 动作开始前:这个 App(或整个电脑控制)被人停了 → 回拒绝原因;否则登记,回这一下的中止信号(人按停止时触发)与收尾。 */
  begin(call: ComputerCall): ComputerCallHandle
  /**
   * #7317 只问不登记:这个 App(或整个电脑控制)此刻是不是被人停着 —— 给「电脑」页签的只读画面用,它 ❌ 亮小条、❌ 算一次操作。
   * 给的是被停的原因(和 begin 拒绝时同一句),没停就是 null。
   */
  stoppedFor(pid: number | undefined): string | null
  /** 小条上的「停止」。 */
  stop(): void
  /** 小条上的「让它继续」。 */
  resume(): void
  dispose(): void
}

export function appStopped(appName: string | undefined): string {
  const app = appName ? `"${appName}"` : 'that app'
  return `The person pressed Stop for ${app} on the bar at the bottom of their screen: they are taking ${app} over. Do not operate ${app} until they press "让它继续 / Let it continue" on that bar; other apps are not affected. Tell them what you did in ${app} and what is left.`
}

export const COMPUTER_STOPPED = 'The person pressed Stop on the bar at the bottom of their screen. Do not use computer.* until they press "让它继续 / Let it continue" on that bar. Tell them what you have done and what is left.'

const LINGER_MS = 30_000
const PAUSED_BAR_MS = 2 * 60_000

/** 停的对象:一个 App(pid),或整个电脑控制。 */
type Subject = number | 'computer'

export function createComputerControl(input: { view: ComputerControlView; lingerMs?: number }): ComputerControl {
  const lingerMs = input.lingerMs ?? LINGER_MS
  /** 被人停了的:pid(或 'computer')→ 当时的 App 名(拒绝时说给 agent 听)。 */
  const paused = new Map<Subject, string | undefined>()
  const inFlight = new Map<Subject, Set<AbortController>>()
  let callerName: string | undefined
  let shown: { subject: Subject; appName?: string; state: 'driving' | 'paused' } | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  const clearHide = () => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
  }
  const hideAfter = (ms: number) => {
    clearHide()
    hideTimer = setTimeout(() => {
      shown = null
      input.view.hide()
    }, ms)
    ;(hideTimer as { unref?: () => void }).unref?.()
  }
  const show = (next: NonNullable<typeof shown>) => {
    shown = next
    clearHide()
    input.view.show({
      state: next.state,
      ...(callerName ? { callerName } : {}),
      ...(next.subject === 'computer' ? {} : { app: next.appName ? { name: next.appName } : {} }),
    })
  }
  const busy = () => [...inFlight.values()].some((set) => set.size > 0)

  return {
    begin(call) {
      if (call.callerName) callerName = call.callerName
      const subject: Subject = call.pid ?? 'computer'
      const blockedBy = paused.has('computer') ? 'computer' : paused.has(subject) ? subject : null
      if (blockedBy !== null) {
        // agent 又来动停了的东西:把暂停的小条重新亮出来,让人看得到、点得到「让它继续」。
        const appName = blockedBy === 'computer' ? undefined : (paused.get(blockedBy) ?? call.appName)
        show({ subject: blockedBy, ...(appName ? { appName } : {}), state: 'paused' })
        hideAfter(PAUSED_BAR_MS)
        return { refused: blockedBy === 'computer' ? COMPUTER_STOPPED : appStopped(appName) }
      }
      const controller = new AbortController()
      const set = inFlight.get(subject) ?? new Set<AbortController>()
      set.add(controller)
      inFlight.set(subject, set)
      // 没指定 App 的动作不盖掉已经亮着的条:正在操作的 App 留着让人认得出、能停;暂停的留着让人点得到「让它继续」。
      if (call.pid !== undefined || !shown) show({ subject, ...(call.appName ? { appName: call.appName } : {}), state: 'driving' })
      else if (shown.state === 'driving') clearHide()
      let ended = false
      return {
        signal: controller.signal,
        end() {
          if (ended) return
          ended = true
          set.delete(controller)
          if (!busy() && shown?.state === 'driving') hideAfter(lingerMs)
        },
      }
    },
    stoppedFor(pid) {
      if (paused.has('computer')) return COMPUTER_STOPPED
      return pid !== undefined && paused.has(pid) ? appStopped(paused.get(pid)) : null
    },
    stop() {
      if (!shown || shown.state !== 'driving') return
      const { subject, appName } = shown
      paused.set(subject, appName)
      const reason = subject === 'computer' ? COMPUTER_STOPPED : appStopped(appName)
      for (const [s, set] of inFlight) {
        if (subject !== 'computer' && s !== subject) continue
        for (const controller of set) controller.abort(reason)
      }
      show({ subject, ...(appName ? { appName } : {}), state: 'paused' })
      hideAfter(PAUSED_BAR_MS)
    },
    resume() {
      if (!shown || shown.state !== 'paused') return
      paused.delete(shown.subject)
      shown = null
      clearHide()
      input.view.hide()
    },
    dispose() {
      clearHide()
      input.view.hide()
    },
  }
}
