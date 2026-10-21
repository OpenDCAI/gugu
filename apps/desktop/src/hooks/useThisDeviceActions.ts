import { useCallback, useEffect, useState } from 'react'
import { DEVICE_ACTIONS_CHANNELS, type DeviceActionsState } from '../lib/deviceActionsIpc'
import { desktopIpc } from '../platform/desktopIpc'

/** 这台电脑「能做的事」此刻的样子(主进程现读);不是桌面 = 一直 null。助理 App「能力 · 设备」那一行也读它。 */
export function useThisDeviceState(): { state: DeviceActionsState | null; reload: () => void } {
  const [state, setState] = useState<DeviceActionsState | null>(null)
  const reload = useCallback(() => {
    const ipc = desktopIpc()
    if (!ipc) return
    void ipc.invoke(DEVICE_ACTIONS_CHANNELS.state).then((next) => setState(next as DeviceActionsState), () => undefined)
  }, [])
  useEffect(() => {
    reload()
    const ipc = desktopIpc()
    return ipc?.eventOn(DEVICE_ACTIONS_CHANNELS.changed, reload)
  }, [reload])
  return { state, reload }
}
