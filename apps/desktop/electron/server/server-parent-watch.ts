/**
 * #6264 账号进程不许比它的守护进程活得久。
 *
 * 守护进程被 kill -9 / OOM 杀掉时(systemd 的 KillMode=process 只杀主进程,为的是留住 tmux),账号进程会变成孤儿:
 * 它还攥着这个账号的单实例锁,新拉起的守护进程再起账号进程就撞锁秒退、永远退避;孤儿跑的还是旧版本,
 * `gugu-server stop` 与卸载也够不着它。这里让账号进程自己发现「父进程换人了」就按正常流程退出 ——
 * 与 VS Code server 的扩展宿主盯父进程、父进程没了就自尽同一个做法(Linux 的 PR_SET_PDEATHSIG 在 Node 里拿不到)。
 *
 * 开销:每 5 秒读一次 process.ppid(一次 getppid 系统调用),不碰磁盘、不起进程。
 */
export const PARENT_WATCH_INTERVAL_MS = 5_000

export type ParentWatchDeps = {
  /** 启动时的父进程号(守护进程)。 */
  expectedParent: number
  currentParent: () => number
  onOrphaned: (info: { expected: number; now: number }) => void
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void }
  clearInterval?: (handle: unknown) => void
}

/** 开始盯。返回停止函数。父进程号 ≤ 1 时(本来就没有守护进程,例如手动跑)不盯。 */
export function watchParent(deps: ParentWatchDeps): () => void {
  if (!Number.isInteger(deps.expectedParent) || deps.expectedParent <= 1) return () => {}
  const every = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clear = deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout))
  let fired = false
  const handle = every(() => {
    if (fired) return
    const now = deps.currentParent()
    if (now === deps.expectedParent) return
    fired = true
    clear(handle)
    deps.onOrphaned({ expected: deps.expectedParent, now })
  }, PARENT_WATCH_INTERVAL_MS)
  handle.unref?.()
  return () => clear(handle)
}
