/**
 * 手机咕咕格里往下钻的页(`sub`)的上一层 —— 手机自己的一张表(❌ 借桌面面板那张:桌面的连接应用页已搬进全局设置,
 * 手机没有会话页宿主,那一组设置不画,连接应用留在这一格的「资料」里)。
 * 名字:`connectors`(列表)、`connector:<id>`(详情)、`connector:<id>:connect`(连接页)、`voice` / `voice:<id>`、
 * `files` / `files:<相对路径>`、`note:<文件名>`、`routine:<id>`、`devices`、`channels`、`customize`、`diaries` / `diary:<id>`。
 */
export type PhoneParentRoute<T extends string = string> = { tab: T; sub?: string; returnTo?: { tab: T; sub?: string } }

/** 从直接展开的列表连接,取消或完成都回到进入前的位置。 */
export function phoneNextRoute<T extends string>(current: PhoneParentRoute<T>, next: PhoneParentRoute<T>): PhoneParentRoute<T> {
  if (current.returnTo && current.sub?.endsWith(':connect') && next.tab === current.tab && next.sub === current.sub.slice(0, -':connect'.length)) return current.returnTo
  if (current.tab === 'profile' && (!current.sub || current.sub === 'connectors') && next.tab === 'profile' && next.sub?.endsWith(':connect'))
    return { ...next, returnTo: { tab: current.tab, sub: current.sub } }
  return next.sub ? next : { tab: next.tab }
}

export function phoneParentRoute<T extends string>(route: PhoneParentRoute<T>): PhoneParentRoute<T> | null {
  if (route.returnTo) return route.returnTo
  const sub = route.sub
  if (!sub) return null
  if (sub.startsWith('connector:')) {
    // 详情回列表;详情之下的连接页(`connector:<id>:connect`)回详情。
    const id = sub.slice('connector:'.length)
    const cut = id.indexOf(':')
    return { tab: route.tab, sub: cut > 0 ? `connector:${id.slice(0, cut)}` : 'connectors' }
  }
  if (sub.startsWith('voice:')) return { tab: route.tab, sub: 'voice' }
  if (sub.startsWith('files:')) {
    const rest = sub.slice('files:'.length)
    const cut = rest.lastIndexOf('/')
    return { tab: route.tab, sub: cut > 0 ? `files:${rest.slice(0, cut)}` : 'files' }
  }
  return { tab: route.tab }
}
