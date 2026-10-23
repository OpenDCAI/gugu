import { describe, expect, it } from 'vitest'
import { sanitizeNavigationSnapshotForRestore } from '../../../../apps/desktop/electron/session/main/core/view-state/navigation-restore'

// #4277 开机默认视图不能落到已归档 / 已删除的会话上。真机:归档「何丽丽」→ 换号重启 → 首屏就是它,
// 「无法加载对话」。恢复那一刻渲染层的会话 store 还没加载,守卫判不出来;主进程读快照时有 DB,这里判。

const snapshot = (sessionId: string, projectId = 'proj-1') => ({
  currentViewId: 'session',
  viewParams: { session: { projectId, sessionId }, project: { projectId: 'proj-other' } },
})

describe('#4277 恢复上次视图前校验会话还活着', () => {
  it('会话已归档 ⇒ 退回它所属项目的视图,session 参数清掉', () => {
    const out = sanitizeNavigationSnapshotForRestore(snapshot('t-archived'), () => 'archived')
    expect(out).toEqual({ currentViewId: 'project', viewParams: { project: { projectId: 'proj-1' } } })
  })

  it('会话已删除 ⇒ 同样退回项目', () => {
    const out = sanitizeNavigationSnapshotForRestore(snapshot('t-gone'), () => 'deleted') as { currentViewId: string }
    expect(out.currentViewId).toBe('project')
  })

  it('会话连项目都不知道 ⇒ home', () => {
    const out = sanitizeNavigationSnapshotForRestore(
      { currentViewId: 'session', viewParams: { session: { sessionId: 't-gone' } } },
      () => 'deleted',
    ) as { currentViewId: string }
    expect(out.currentViewId).toBe('home')
  })

  it('会话在别的机器上(咕咕 server)⇒ 照样恢复到它:本机表里没有它不等于删了', () => {
    const snap = snapshot('t-on-server')
    expect(sanitizeNavigationSnapshotForRestore(snap, () => 'elsewhere')).toBe(snap)
  })

  it('对照:会话活着 ⇒ 原样返回(证明不是「恢复一律退回」)', () => {
    const snap = snapshot('t-live')
    expect(sanitizeNavigationSnapshotForRestore(snap, () => 'live')).toBe(snap)
  })

  it('对照:上次不在会话视图 ⇒ 不碰,也不查会话', () => {
    const snap = { currentViewId: 'project', viewParams: { project: { projectId: 'p' } } }
    let asked = 0
    expect(sanitizeNavigationSnapshotForRestore(snap, () => { asked++; return 'deleted' })).toBe(snap)
    expect(asked).toBe(0)
  })

  it('坏快照(非对象 / 无 sessionId)原样返回,不抛', () => {
    expect(sanitizeNavigationSnapshotForRestore(null, () => 'deleted')).toBeNull()
    const noSession = { currentViewId: 'session', viewParams: {} }
    expect(sanitizeNavigationSnapshotForRestore(noSession, () => 'deleted')).toBe(noSession)
  })
})
