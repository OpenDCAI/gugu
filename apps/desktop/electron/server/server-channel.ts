/**
 * 给别的机器装哪条通道的 server:跟这台桌面**实际连的那个库**走,❌ 跟构建类型走。
 * 正式通道的包烘的是生产库,Beta 通道的包烘的是共享测试库(gugu-dev 两条出包道各自的 environment)。
 * 开发构建的 tier 默认也是 production,按 tier 选会让连测试库的开发版装上连生产库的 server ——
 * 测试账号的登录码被送去生产库(10-28 真机撞到)。
 * 生产库以外的库一律装 Beta:自建的本地库没有发布过的包,要用 GUGU_SERVER_DOWNLOAD_BASE 指到自己打的包。
 */
export function serverChannelForBackend(supabaseUrl: string | null, productionHost: string): 'stable' | 'beta' {
  return hostOf(supabaseUrl) === productionHost ? 'stable' : 'beta'
}

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
