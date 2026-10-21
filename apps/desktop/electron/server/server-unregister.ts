/**
 * `gugu-server unregister --account <账号 id>`(#6264 卸载时注销这台机器上的每个账号)。
 *
 * 照 VS Code `code tunnel unregister`:把这台机器从这个账号里拿掉,并让它在这台机器上的续期令牌作废 ——
 * ❌ 只删本地文件(那样云端的会话一直有效,账号的设备列表里还挂着一台永远离线的机器)。
 * 顺序:用续期令牌换一次新的访问令牌 → 从这个账号里移除这台机器(`remove_device`;绑着智能体时库会拒,
 * 那就只注销、不删那一行)→ 向 GoTrue 注销这个会话 → 删本地登录态。每一步失败都往下走(卸载不等网络),
 * 最后打一行 `__GUGU_UNREGISTERED__ <removed|revoked|local>` 说做到了哪。
 *
 * 一个进程只处理一个账号:本机加密密钥与数据目录按账号分,替身的 userData 读一次就缓存住(见 server-layout.ts),
 * 所以卸载脚本按账号逐个调它。网络步骤注入,单测钉住。
 */
export const UNREGISTERED_MARK = '__GUGU_UNREGISTERED__'

export type UnregisterDeps = {
  readSession: () => { accessToken: string; refreshToken: string } | null
  refresh: (refreshToken: string) => Promise<string | null>
  deviceId: (accessToken: string) => Promise<string | null>
  removeDevice: (accessToken: string, deviceId: string) => Promise<void>
  revoke: (accessToken: string) => Promise<void>
  clearLocal: () => void
  out: (line: string) => void
}

export async function runUnregister(deps: UnregisterDeps): Promise<'removed' | 'revoked' | 'local' | 'none'> {
  const session = deps.readSession()
  if (!session) return 'none'
  let outcome: 'removed' | 'revoked' | 'local' = 'local'
  const access = await deps.refresh(session.refreshToken).catch(() => null)
  if (access) {
    const deviceId = await deps.deviceId(access).catch(() => null)
    let removed = false
    if (deviceId) removed = await deps.removeDevice(access, deviceId).then(() => true, () => false)
    const revoked = await deps.revoke(access).then(() => true, () => false)
    outcome = removed ? 'removed' : revoked ? 'revoked' : 'local'
  }
  deps.clearLocal()
  deps.out(`${UNREGISTERED_MARK} ${outcome}`)
  return outcome
}
