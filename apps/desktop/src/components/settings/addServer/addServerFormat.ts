// #6264 添加一台机器:界面上要拼的几样文字(字节、系统摘要、要复制给管理员的命令)。纯函数,单测直接测。
import type { Device } from '@gugu/core/shared/types/chat'
import type { ServerSshInstallMachine, ServerSshInstallStep, SshConfigHost } from '../../../lib/serverSshInstall'

/** 1536 → `1.5 KB`;给进度用,一位小数、按 1024 进位。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/** 下载 / 上传进度:`23.4 MB / 105.3 MB · 22%`;总量未知就只写已完成的量。 */
export function progressText(progress: NonNullable<ServerSshInstallStep['progress']>): string {
  if (progress.total && progress.total > 0) {
    const percent = Math.min(100, Math.floor((progress.done / progress.total) * 100))
    return `${formatBytes(progress.done)} / ${formatBytes(progress.total)} · ${percent}%`
  }
  return formatBytes(progress.done)
}

function archLabel(arch: string): string {
  if (arch === 'x86_64' || arch === 'amd64') return 'x64'
  if (arch === 'aarch64') return 'arm64'
  return arch
}

/** 识别出来的系统,一行:`Ubuntu 22.04.4 LTS · arm64 · glibc 2.35`。 */
export function machineSummary(machine: Pick<ServerSshInstallMachine, 'os' | 'distro' | 'arch' | 'libc'>): string {
  const system = machine.distro || (machine.os === 'Darwin' ? 'macOS' : machine.os)
  return [system, archLabel(machine.arch), machine.libc].filter(Boolean).join(' · ')
}

/** 给 shell 用的单引号转义(命令里带 `[` `]` 时 zsh 会当通配,必须引起来)。 */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_.@:/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** 指纹变了时,删掉旧记录的那条命令。 */
export function knownHostsRemoveCommand(host: string): string {
  return `ssh-keygen -R ${shellQuote(host)}`
}

/** 请管理员开启「退出登录后继续运行」的那条命令。 */
export function lingerCommand(user: string): string {
  return `sudo loginctl enable-linger ${shellQuote(user)}`
}

/** 输入框下的配置主机建议:别名、主机名算(用户不算),不分大小写,开头对上的在前;空串 = 全部。 */
export function filterSshConfigHosts(hosts: readonly SshConfigHost[], query: string): SshConfigHost[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...hosts]
  // 只按别名与主机名匹配:用户名不算(打个「d」不该因为用户叫 administrator 就把 bastion 列出来)。
  // 开头就对上的排在前面,只是中间含有的排在后面;同一档里保持 ~/.ssh/config 里的先后。
  const fields = (host: SshConfigHost) => [host.alias, host.hostname ?? ''].map((field) => field.toLowerCase())
  const prefix: SshConfigHost[] = []
  const contains: SshConfigHost[] = []
  for (const host of hosts) {
    const values = fields(host)
    if (values.some((value) => value.startsWith(needle))) prefix.push(host)
    else if (values.some((value) => value.includes(needle))) contains.push(host)
  }
  return [...prefix, ...contains]
}

/** 展开「添加」之后新出现、且已经在线的机器(一行命令装完、在网页上点了允许之后,它会自己出现)。云端那一行不算。 */
export function newlyAppearedDevices(before: ReadonlySet<string>, devices: readonly Device[]): Device[] {
  return devices.filter((device) => device.is_online && !before.has(device.device_id) && !device.device_id.startsWith('cloud:'))
}

/**
 * SSH 装好之后,这次装上的那台机器此刻是否已经出现在设备列表里并在线(#6264)。
 *
 * 「装好」(登录成功)≠「出现」:那台机器上常驻的 server 接上新账号、发出第一下心跳之后才有设备行 ——
 * 实测两次都在装好之后约 6 秒。知道它的设备 id 就只认那一台(重新接上的老机器也算);
 * 装的时候没解析出 id(网络抖了)就认展开之后新出现、且在线的那一台。
 */
export function landedDevice(deviceId: string | null, before: ReadonlySet<string>, devices: readonly Device[]): Device | null {
  if (deviceId) return devices.find((device) => device.device_id === deviceId && device.is_online) ?? null
  return newlyAppearedDevices(before, devices)[0] ?? null
}
