import { getSupabaseUrl } from '@gugu/core/cloud/config'

/**
 * 咕咕 App 自己接的链接。聊天里点的(chatLinks)与系统交给 App 的(安卓 App Links,见 AndroidManifest 的 server-login
 * 那一条)都只经 openAppLink 这一个口:认出来、且这个外壳上有页面接(手机壳挂着 ServerLoginApproveHost)就在 App 里打开,
 * 返回 true;否则 false,链接照常去浏览器。
 *
 * 现在只有一种:`gugu-server login` 打出的 `<库>/functions/v1/server-login?code=…` —— 在 App 里以自己的登录批准那台机器。
 */
export const SERVER_LOGIN_APPROVE_EVENT = 'gugu:server-login-approve'

export type ServerLoginApproveDetail = { code: string }

/**
 * 这条链接是不是本包所连那个库的 server-login 确认页;是 = 它带的短码(没带 = 空串,批准页照实说找不到)。
 * 别的库的链接不认(那条请求不在我们的库里)。
 */
export function serverLoginCode(url: string, supabaseUrl: string): string | null {
  let link: URL
  let base: URL
  try {
    link = new URL(url)
    base = new URL(supabaseUrl)
  } catch {
    return null
  }
  if (link.origin !== base.origin) return null
  if (link.pathname.replace(/\/+$/, '') !== `${base.pathname.replace(/\/+$/, '')}/functions/v1/server-login`) return null
  return link.searchParams.get('code')?.trim() ?? ''
}

export function openAppLink(url: string): boolean {
  const code = serverLoginCode(url, getSupabaseUrl())
  if (code === null) return false
  const detail: ServerLoginApproveDetail = { code }
  return !window.dispatchEvent(new CustomEvent(SERVER_LOGIN_APPROVE_EVENT, { detail, cancelable: true }))
}
