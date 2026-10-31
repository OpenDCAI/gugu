// #6264 远程 SSH 的机器连不上时,全局那张浮卡(components/SshLinkSignIn.tsx)此刻挂哪一条。纯函数。
import type { SshLinkFailure } from './sshLink'

/** 要这张卡片出面的原因(纯连不上 = 各模块自己的「问不到」已经说了,这里不重复)。 */
const NOTICE_REASONS: ReadonlySet<SshLinkFailure> = new Set([
  'signInRequired',
  'hostKeyChanged',
  'outdated',
  'refused',
  'updating',
  'waitingIdle',
  'notSignedIn',
  'notInstalled',
])

export type SshLinkNotice = { deviceId: string; name: string; reason: SshLinkFailure }

/** 此刻该挂哪一条(一次只挂一条,按设备列表的顺序)。纯函数。 */
export function pickSshLinkNotice(input: {
  problems: ReadonlyMap<string, SshLinkFailure>
  machines: readonly { device_id: string; label: string }[]
  dismissed: ReadonlyMap<string, SshLinkFailure>
}): SshLinkNotice | null {
  for (const machine of input.machines) {
    const reason = input.problems.get(machine.device_id)
    if (!reason || !NOTICE_REASONS.has(reason)) continue
    if (input.dismissed.get(machine.device_id) === reason) continue
    return { deviceId: machine.device_id, name: machine.label, reason }
  }
  return null
}
