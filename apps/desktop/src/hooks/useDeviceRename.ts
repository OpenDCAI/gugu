// 设备改名的状态与落库(DeviceRenameField 的另一半):设置那一行与设备详情页共用。
import { useCallback, useState } from 'react'
import type { Device } from '@gugu/core/shared/types/chat'
import { useDevicesStore } from '../store/devicesContext'
import { messageForUser } from '../lib/userFacingError'
import { rendererLogger } from '../lib/log'

const log = rendererLogger('devices')

/** 正在改哪一台、改名失败说什么。没变 / 空 ⇒ 直接收起,❌ 发一次空改名。 */
export function useDeviceRename() {
  const { rename } = useDevicesStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const start = useCallback((device: Device) => { setFailure(null); setEditingId(device.device_id) }, [])
  const cancel = useCallback(() => setEditingId(null), [])
  const save = useCallback(async (device: Device, draft: string) => {
    const next = draft.trim()
    if (!next || next === device.label) { setEditingId(null); return }
    try {
      await rename(device.device_id, next)
      setEditingId(null)
    } catch (err) {
      log.error({ err: String((err as Error)?.message ?? err), deviceId: device.device_id }, 'rename device failed')
      setFailure({ id: device.device_id, message: messageForUser(err) })
    }
  }, [rename])
  const failedFor = (deviceId: string) => (failure?.id === deviceId ? failure.message : '')
  return { editingId, start, cancel, save, failedFor }
}
