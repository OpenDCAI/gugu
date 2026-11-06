import { useCallback, useEffect, useState } from 'react'
import { DEVICE_ACTIONS_CHANNELS, type DeviceActionsState } from '../lib/deviceActionsIpc'
import { rendererLogger } from '../lib/log'
import { messageForUser } from '../lib/userFacingError'
import { desktopIpc } from '../platform/desktopIpc'

const log = rendererLogger('device-actions')

/** 这台电脑「能做的事」此刻的样子(主进程现读);不是桌面 = 一直 null。助理 App「能力 · 设备」那一行也读它。读取失败 ❌ 一直停在「读取中」。 */
export function useThisDeviceState(): { state: DeviceActionsState | null; readError: string | null; reload: () => void } {
  const [state, setState] = useState<DeviceActionsState | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const reload = useCallback(() => {
    const ipc = desktopIpc()
    if (!ipc) return
    void ipc.invoke(DEVICE_ACTIONS_CHANNELS.state).then((next) => {
      setState(next as DeviceActionsState)
      setReadError(null)
    }, (error: unknown) => {
      log.error({ error: String(error) }, 'this device actions state read failed')
      setReadError(messageForUser(error))
    })
  }, [])
  useEffect(() => {
    reload()
    const ipc = desktopIpc()
    return ipc?.eventOn(DEVICE_ACTIONS_CHANNELS.changed, reload)
  }, [reload])
  return { state, readError, reload }
}
