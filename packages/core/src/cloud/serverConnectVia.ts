/**
 * #6264 远程 SSH / 远程隧道:这台机器是怎么添加的(product spec「添加一台机器」)。
 *
 * 一个账号在一台咕咕 server 上是怎么登上的,记在这个账号自己的数据目录里(`connect-via.json`):
 *  · ssh:从桌面经远程 SSH 装上(`gugu-server login --grant-stdin`),或者老机器第一次被装它的那台桌面经 SSH 接上时补记;
 *  · tunnel:一行命令 + 确认页(`gugu-server login`)。
 * 最近一次登录说了算(远程 SSH 装的机器后来又用一行命令登了一次 = 改成远程隧道)。
 *
 * 随心跳报 `capabilities.connect_via`(这台 server 自己说,❌ 靠别的端各自猜):设备列表按它标连法,
 * 机器上限按它数远程隧道那一档。连法不决定在哪些端出现 —— 两种都处处列出、处处能用(owner 2026-10-08 选 B)。
 * 读不到 / 没有 = 远程隧道(老机器、老版本的口径,与库里机器上限没有登记时一样)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeviceConnectVia } from '../shared/types/deviceHost'

export const SERVER_CONNECT_VIA_FILE = 'connect-via.json'

/** name:经远程 SSH 装上时人填的那台机器的名字(SSH 别名 / 主机,见 ssh-install machineNameFromTarget);没有就不记。 */
export type ServerConnectVia = { via: DeviceConnectVia; at: string; name?: string }

export function parseServerConnectVia(text: string | null): ServerConnectVia | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<ServerConnectVia>
    if ((value.via === 'ssh' || value.via === 'tunnel') && typeof value.at === 'string') {
      const name = typeof value.name === 'string' ? value.name.trim() : ''
      return { via: value.via, at: value.at, ...(name ? { name } : {}) }
    }
  } catch {
    // 坏了 = 不知道
  }
  return null
}

/** 这个账号数据目录里记的那一条;没有 / 坏了 = null(调用方按远程隧道算)。 */
export function readServerConnectVia(
  accountDataDir: string | undefined,
  readText: (path: string) => string | null = defaultReadText,
): ServerConnectVia | null {
  if (!accountDataDir) return null
  return parseServerConnectVia(readText(join(accountDataDir, SERVER_CONNECT_VIA_FILE)))
}

/**
 * 这个账号进程随心跳报的名字。库里只在**第一次插入**这一行时采用它(空 ⇒ 触发器取 `Linux 1` 这类不撞号的名字),
 * 之后的心跳改不动名字(preserve 触发器),只有人改名才改。
 */
export function serverDeviceLabel(env: NodeJS.ProcessEnv, readText?: (path: string) => string | null): string {
  return readServerConnectVia(env.GUGU_TASK_HOST_USER_DATA, readText)?.name ?? ''
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
