/**
 * 不问人的一次性 SSH 命令(`gugu-server link` / `status --json` 这类):与终端直连同一个复用连接的套接字(ControlMaster),
 * 终端开着的话这一次不用重新握手。`BatchMode=yes`:这里没有地方问人要密码,复用不上又要密码 = 此刻走不通,调用方如实报。
 */
import { SHARED_CONTROL_PERSIST, type SshTarget } from './ssh-install/logic'

export function sshBatchArgs(target: SshTarget, remoteCommand: string, controlPath: string | null): string[] {
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
  ]
  if (controlPath) {
    args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', `ControlPersist=${SHARED_CONTROL_PERSIST}`)
  }
  if (target.port !== undefined) args.push('-p', String(target.port))
  // 添加这台机器时给的额外选项(-i 身份文件、-J 跳板……),跟安装、直连终端同一套;漏了就连不上。
  if (target.options?.length) args.push(...target.options)
  args.push('--', target.destination, remoteCommand)
  return args
}
