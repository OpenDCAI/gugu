/**
 * #4277 开机恢复「上次视图」前的一道校验(纯函数,便于判):
 *
 * 导航快照记着「上次停在会话 S 的视图」。用户归档 / 删除了 S 再重启,渲染层照样恢复到 S ——
 * 而恢复那一刻会话 store 还没加载,渲染层的 canActivate 守卫看不出 S 已经没了 / 已归档,于是开机默认
 * 视图就是一条打不开的会话(真机:归档「何丽丽」→ 换号重启 → 首屏「无法加载对话」)。
 * 主进程读快照时有 DB,在这里判:S 不是活着的会话 ⇒ 退回它的项目视图;连项目都不知道 ⇒ home。
 * 只改「恢复」这一步:用户主动点开归档会话照旧可达(那走 navigate,不走这里)。
 */
export type RestoredSessionState = 'live' | 'archived' | 'missing'

export interface NavigationSnapshotLike {
  currentViewId?: unknown
  viewParams?: Record<string, unknown>
}

export function sanitizeNavigationSnapshotForRestore(
  snapshot: unknown,
  sessionState: (sessionId: string) => RestoredSessionState,
): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  const snap = snapshot as NavigationSnapshotLike
  if (snap.currentViewId !== 'session') return snapshot
  const sessionParams = snap.viewParams?.session
  const projectId = typeof (sessionParams as { projectId?: unknown } | undefined)?.projectId === 'string'
    ? ((sessionParams as { projectId: string }).projectId)
    : ''
  const sessionId = typeof (sessionParams as { sessionId?: unknown } | undefined)?.sessionId === 'string'
    ? ((sessionParams as { sessionId: string }).sessionId)
    : ''
  if (!sessionId) return snapshot
  if (sessionState(sessionId) === 'live') return snapshot
  const viewParams = { ...(snap.viewParams ?? {}) }
  delete viewParams.session
  if (projectId) {
    return { ...snap, currentViewId: 'project', viewParams: { ...viewParams, project: { projectId } } }
  }
  return { ...snap, currentViewId: 'home', viewParams }
}
