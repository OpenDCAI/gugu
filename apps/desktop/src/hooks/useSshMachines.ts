import { useCallback, useEffect, useState } from 'react'
import { SERVER_SSH_MACHINES_CHANNELS, type SshMachineSummary } from '../lib/serverSshMachines'
import { desktopIpc } from '../platform/desktopIpc'

/**
 * 这台桌面上用 SSH 装上的机器(设备 id → 给人看的地址),见 electron/server/ssh-machines.ts。
 * 装上 / 忘掉一台时跟着变。没有桌面主进程(网页、手机)⇒ 空:那里没有 SSH 这条路。
 */
export function useSshMachines(): {
  addresses: ReadonlyMap<string, string>
  forget: (deviceId: string) => Promise<void>
} {
  const [addresses, setAddresses] = useState<ReadonlyMap<string, string>>(() => new Map())

  useEffect(() => {
    const electron = desktopIpc()
    if (!electron) return
    let live = true
    const load = () => {
      void electron.invoke(SERVER_SSH_MACHINES_CHANNELS.describe).then(
        (value) => {
          if (!live || !Array.isArray(value)) return
          const next = new Map<string, string>()
          for (const item of value as SshMachineSummary[]) {
            if (item && typeof item.deviceId === 'string' && typeof item.display === 'string') next.set(item.deviceId, item.display)
          }
          setAddresses(next)
        },
        () => undefined,
      )
    }
    load()
    const off = electron.eventOn(SERVER_SSH_MACHINES_CHANNELS.changed, load)
    return () => {
      live = false
      off()
    }
  }, [])

  const forget = useCallback(async (deviceId: string) => {
    const electron = desktopIpc()
    if (!electron) return
    await electron.invoke(SERVER_SSH_MACHINES_CHANNELS.forget, deviceId)
  }, [])

  return { addresses, forget }
}
