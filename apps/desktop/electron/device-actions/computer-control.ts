/**
 * #7199 电脑控制的「正在操作 · 停止」小条与人接管 —— 按 App 算,不按整台电脑算(owner 10-15:「不接管电脑,只接管这个 App」):
 *
 * - agent 操作某个 App 时,提示附着到实际目标窗口;只读调用不进入控制器。
 *   没指定 App 的操作也更新提示,让停止能中止当前动作;只读调用不盖掉提示。
 *   最后一个动作做完半分钟没有下一个,小条收起。
 * - 人照常用电脑 —— 包括点进、挪动 agent 正在操作的那个 App —— 都不打断它:cua-driver 在后台做事,不碰人的真鼠标和前台。
 * - 「停止」只停小条上的那个 App:它在途的动作中断,之后 agent 再动这个 App 一律拒,直到人点「让它继续」;别的 App 照常。
 *   没指定 App 时提示附着前台窗口,停止仍作用于整个电脑控制。
 */

/** 窗口附着提示(main 用一个不抢焦点、不进截图的小窗实现;测试换成记录器)。没有 app 时附着前台窗口。 */
export interface ComputerControlView {
  show(view: { state: 'driving' | 'paused'; callerName?: string; taskTitle?: string; app?: { pid: number; name?: string; windowId?: number } }): void | Promise<boolean>
  hide(): void
}

/** 一个动作:针对哪个 App(pid;不指定 App 的动作没有)。 */
export interface ComputerCall {
  /** Cold launch is cancellable before the target has a window to show on. */
  deferAttachment?: boolean
  callerName?: string
  taskTitle?: string
  pid?: number
  /** All Apps touched by one native batch, independently of indicator placement. */
  targetPids?: readonly number[]
  windowId?: number
  appName?: string
}

export type ComputerCallHandle = { refused: string } | { signal: AbortSignal; ready?: Promise<boolean>; end(): void }

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
  return `The person pressed Stop for ${app} on its window's control bar: they are taking ${app} over. Do not operate ${app} until they press "继续 / Continue" on that bar; other apps are not affected. Tell them what you did in ${app} and what is left.`
}

export const COMPUTER_STOPPED = 'The person stopped computer control. Do not use computer.* until they allow it to continue. Tell them what you have done and what is left.'

const LINGER_MS = 30_000
const PAUSED_BAR_MS = 2 * 60_000

/** 停的对象:一个 App(pid),或整个电脑控制。 */
type Subject = number | 'computer'

export function createComputerControl(input: { view: ComputerControlView; lingerMs?: number }): ComputerControl {
  const lingerMs = input.lingerMs ?? LINGER_MS
  /** 被人停了的:pid(或 'computer')→ 当时的 App 名(拒绝时说给 agent 听)。 */
  const paused = new Map<Subject, { appName?: string; windowId?: number }>()
  const inFlight = new Map<Subject, Set<AbortController>>()
  let shown: { subject: Subject; appName?: string; windowId?: number; callerName?: string; taskTitle?: string; state: 'driving' | 'paused' } | null = null
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
    return input.view.show({
      state: next.state,
      ...(next.callerName ? { callerName: next.callerName } : {}),
      ...(next.taskTitle ? { taskTitle: next.taskTitle } : {}),
      ...(next.subject === 'computer' ? {} : { app: { pid: next.subject, ...(next.appName ? { name: next.appName } : {}), ...(next.windowId !== undefined ? { windowId: next.windowId } : {}) } }),
    })
  }
  const busy = () => [...inFlight.values()].some((set) => set.size > 0)

  return {
    begin(call) {
      const identity = { ...(call.callerName ? { callerName: call.callerName } : {}), ...(call.taskTitle ? { taskTitle: call.taskTitle } : {}) }
      const subject: Subject = call.pid ?? 'computer'
      const subjects = new Set<Subject>([subject, ...(call.targetPids ?? [])])
      const blockedBy = paused.has('computer') ? 'computer' : [...subjects].find(target => paused.has(target)) ?? null
      if (blockedBy !== null) {
        // agent 又来动停了的东西:把暂停的小条重新亮出来,让人看得到、点得到「让它继续」。
        const appName = blockedBy === 'computer' ? undefined : (paused.get(blockedBy)?.appName ?? (call.pid === blockedBy ? call.appName : undefined))
        const windowId = blockedBy === 'computer' ? undefined : ((call.pid === blockedBy ? call.windowId : undefined) ?? paused.get(blockedBy)?.windowId)
        show({ subject: blockedBy, ...identity, ...(appName ? { appName } : {}), ...(windowId !== undefined ? { windowId } : {}), state: 'paused' })
        hideAfter(PAUSED_BAR_MS)
        return { refused: blockedBy === 'computer' ? COMPUTER_STOPPED : appStopped(appName) }
      }
      const controller = new AbortController()
      const sets = [...subjects].map(target => {
        const set = inFlight.get(target) ?? new Set<AbortController>()
        set.add(controller)
        inFlight.set(target, set)
        return set
      })
      // Every begin is an act. Untargeted input must replace an old App's
      // identity too, so Stop aborts this subject instead of the previous App.
      const windowId = call.windowId
      const ready = call.deferAttachment ? undefined : show({ subject, ...identity, ...(call.appName ? { appName: call.appName } : {}), ...(windowId !== undefined ? { windowId } : {}), state: 'driving' })
      let ended = false
      return {
        signal: controller.signal,
        ...(ready ? { ready } : {}),
        end() {
          if (ended) return
          ended = true
          for (const set of sets) set.delete(controller)
          if (!busy() && shown?.state === 'driving') hideAfter(lingerMs)
        },
      }
    },
    stoppedFor(pid) {
      if (paused.has('computer')) return COMPUTER_STOPPED
      return pid !== undefined && paused.has(pid) ? appStopped(paused.get(pid)?.appName) : null
    },
    stop() {
      if (!shown || shown.state !== 'driving') return
      const prior = shown
      const { subject, appName, windowId } = shown
      paused.set(subject, { ...(appName ? { appName } : {}), ...(windowId !== undefined ? { windowId } : {}) })
      const reason = subject === 'computer' ? COMPUTER_STOPPED : appStopped(appName)
      for (const [s, set] of inFlight) {
        if (subject !== 'computer' && s !== subject) continue
        for (const controller of set) controller.abort(reason)
      }
      show({ ...prior, state: 'paused' })
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
