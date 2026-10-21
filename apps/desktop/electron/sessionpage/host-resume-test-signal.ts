/**
 * @@@test-seam host-resume —— 只在 `GUGU_TEST_HOST_RESUME=1` 时注册的第三个 resume 触发器。
 *
 * 宿主原本只有两条 host-resume 边界:`powerMonitor.on('resume')`(真实 sleep/wake)与
 * `mainWindow.on('focus')`(用户回到应用)。两条都要求一个**能切焦点的 GUI 会话** —— 在锁屏、
 * 无人值守的测试机上,窗口拿不到 key 状态,两条都按不动,于是这条线在那种机器上完全不可测。
 *
 * 这个信号不是第三条语义:它**只把宿主已有的那个 resume 对账再跑一次**,不读状态、不碰 lease、
 * 不调 ready gate、不认识任何 provider(与 spec「resume 只标记过期候选,不主动改变 lease」一致)。
 * 不设 env 时**根本不注册监听器**,生产路径一个字节不变。
 */

export const HOST_RESUME_TEST_ENV = 'GUGU_TEST_HOST_RESUME'
export const HOST_RESUME_TEST_SIGNAL = 'SIGUSR2'

export type HostResumeTestSignalDeps = {
  env: Record<string, string | undefined>
  /** 只要 `on`:这条线不摘监听器,进程活多久它活多久。 */
  signals: Pick<NodeJS.Process, 'on'>
  /**
   * 现读,不在注册时取值:宿主的 resume 对账在会话页运行时装好之后才被赋值,
   * 注册那一刻取到的必然是 null(与 main.ts 里 powerMonitor 那条同一个理由)。
   */
  reconcile: () => (() => Promise<void>) | null
  onTriggered: (info: { hasReconcile: boolean }) => void
  onError: (error: unknown) => void
}

/** @returns 是否真的注册了监听器 —— env 没开就是 false,调用方据此判断「没开 = 没装」。 */
export function registerHostResumeTestSignal(deps: HostResumeTestSignalDeps): boolean {
  if (deps.env[HOST_RESUME_TEST_ENV] !== '1') return false
  deps.signals.on(HOST_RESUME_TEST_SIGNAL, () => {
    const reconcile = deps.reconcile()
    deps.onTriggered({ hasReconcile: Boolean(reconcile) })
    if (!reconcile) return
    void reconcile().catch(deps.onError)
  })
  return true
}
