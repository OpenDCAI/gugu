/**
 * 这台电脑在「设备」里叫什么。❌ 用 os.hostname() 直接当名字:macOS 上它常常是网络给的地址
 * (实测一台 MBP 拿到 `192.168.10.98`,截成 `192` 出现在机器选择器里),人认不出。
 *
 *  · macOS:「系统设置 → 通用 → 关于本机」里那个名字(`scutil --get ComputerName`),其次本地主机名(LocalHostName);
 *  · Windows:COMPUTERNAME;
 *  · Linux 及其它:主机名第一段;
 *  · 任何一个候选长得像 IP(或 IP 截出来的那一截数字)都跳过;全不可用 = 空串,由库按平台起「Mac 1 / Linux 1」。
 */
import { spawnSync } from '../local/childProcess'
import { hostname as osHostname, platform as osPlatform } from 'node:os'
import { isIpLikeLabel } from '../shared/ipLikeLabel'

export { isIpLikeLabel }

export function resolveMachineDisplayName(input: {
  platform: string
  env: NodeJS.ProcessEnv
  hostname: string
  /** 跑一条命令拿 stdout(失败 = null)。 */
  run: (command: string, args: string[]) => string | null
}): string {
  const candidates: Array<string | null | undefined> = []
  if (input.platform === 'darwin') {
    candidates.push(input.run('scutil', ['--get', 'ComputerName']))
    candidates.push(input.run('scutil', ['--get', 'LocalHostName']))
  }
  if (input.platform === 'win32') candidates.push(input.env.COMPUTERNAME)
  // 主机名整串是 IP 时先整串判(否则 `192.168.10.98` 会被截成 `192` 再判一次)。
  const host = input.hostname.trim()
  candidates.push(isIpLikeLabel(host) ? null : host.replace(/\.local$/i, '').split('.')[0])
  for (const candidate of candidates) {
    const name = candidate?.trim()
    if (name && !isIpLikeLabel(name)) return name
  }
  return ''
}

let cached: string | null = null

/** 本进程算一次(名字在一次运行里不会变;心跳每 30 秒要一次,❌ 每次都起 scutil)。 */
export function machineDisplayName(): string {
  cached ??= resolveMachineDisplayName({
    platform: osPlatform(),
    env: process.env,
    hostname: osHostname(),
    run: (command, args) => {
      try {
        const result = spawnSync(command, args, { encoding: 'utf8', timeout: 1_000 })
        return result.status === 0 ? result.stdout.trim() : null
      } catch {
        return null
      }
    },
  })
  return cached
}
