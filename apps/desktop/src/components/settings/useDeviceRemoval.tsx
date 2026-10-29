import { messageForUser } from '@/lib/userFacingError'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { deviceRowModel, type BoundAgentsState } from '../../lib/deviceRowModel'
import { deviceMachineFor, type DeviceMachine } from '../../lib/deviceMachines'
import { supersededBy } from '../../lib/deviceSuperseded'
import { rendererLogger } from '../../lib/log'
import { useSshMachines } from '../../hooks/useSshMachines'
import { useDevicesStore } from '../../store/devicesContext'
import { Sheet } from '../ui/Sheet'
import { DeviceMachineConfigurations, type DeviceConfigurationActions } from '../devices/DeviceMachineConfigurations'
import { DeviceRemoveDialog } from './DeviceRemoveDialog'
import { ServerUninstallDialog } from './ServerUninstallDialog'

const log = rendererLogger('devices')

// 「移除」的确认页与「移除版本」的版本列表:设置 › 设备与助理的设备页共用一份(同一个确认、同一个删除 API)。
// 从版本列表里点的移除,取消或删完回到版本列表(还剩 ≥2 个版本时),好一个个删。
// 移除整台机器 = 它的每一个版本都移除(留下一个,它还占着一个名额)。
type DialogState =
  | { kind: 'remove'; devices: Device[]; removing: boolean; failed: string; machineKey?: string }
  | { kind: 'uninstall'; device: Device; machineKey?: string }
  | { kind: 'versions'; machineKey: string }

export function useDeviceRemoval(machines: readonly DeviceMachine[]): {
  addressOf: (deviceId: string) => string | null
  openRemove: (device: Device) => void
  /**
   * 经同一个确认页移除这些设备(同一台机器的版本;当前这台跳过)。传一台机器的全部 device_id = 移除整台机器,
   * 每个版本都删;只传其中几个 = 只移除这几个版本。
   */
  openRemoveDevices: (deviceIds: readonly string[]) => void
  openUninstall: (device: Device) => void
  /** 一台机器有 ≥2 个版本时的「移除」:先列出版本,每个(当前这台除外)单独移除。 */
  openVersions: (device: Device) => void
  configurationActions: DeviceConfigurationActions
  dialogs: ReactNode
} {
  const { t } = useTranslation('settings')
  const { remove, listBoundAgents } = useDevicesStore()
  const { addresses, forget } = useSshMachines()
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [agents, setAgents] = useState<BoundAgentsState>({ agents: [], loading: false, cascadeChecked: false })
  const addressOf = useCallback((deviceId: string) => addresses.get(deviceId) ?? null, [addresses])

  const loadAgents = useCallback(async (devices: readonly Device[]) => {
    setAgents({ agents: [], loading: true, cascadeChecked: false })
    try {
      const lists = await Promise.all(devices.map(device => listBoundAgents(device.device_id)))
      setAgents({ agents: lists.flat(), loading: false, cascadeChecked: false })
    } catch (err) {
      // 列不出来 ⇒ 按「没有」走非级联移除:真有的话库会拦下(DEVICE_HAS_AGENTS),确认页报「没能移除」,
      // ❌ 不会在没让人看过清单的情况下把智能体一起删掉。
      log.error({ err: String((err as Error)?.message ?? err), deviceIds: devices.map(device => device.device_id) }, 'list bound agents failed')
      setAgents({ agents: [], loading: false, cascadeChecked: false })
    }
  }, [listBoundAgents])

  const versionsOf = (machineKey?: string) => machines.find(machine => machine.key === machineKey)
  // 回到版本列表:那台还剩 ≥2 个版本才回去,否则就关掉。
  const back = (machineKey?: string) => {
    const machine = versionsOf(machineKey)
    setDialog(machine && machine.configurations.length > 1 ? { kind: 'versions', machineKey: machine.key } : null)
  }

  const openRemove = useCallback((device: Device) => {
    setDialog(current => ({ kind: 'remove', devices: [device], removing: false, failed: '', machineKey: current?.kind === 'versions' ? current.machineKey : undefined }))
    void loadAgents([device])
  }, [loadAgents])

  const openRemoveDevices = useCallback((deviceIds: readonly string[]) => {
    const devices = machines.flatMap(machine => machine.configurations).filter(device => deviceIds.includes(device.device_id) && !device.is_current_device)
    if (devices.length === 0) return
    setDialog({ kind: 'remove', devices, removing: false, failed: '' })
    void loadAgents(devices)
  }, [machines, loadAgents])

  const openUninstall = useCallback((device: Device) => {
    setDialog(current => ({ kind: 'uninstall', device, machineKey: current?.kind === 'versions' ? current.machineKey : undefined }))
    void loadAgents([device])
  }, [loadAgents])

  const openVersions = useCallback((device: Device) => {
    const machine = deviceMachineFor(machines, device.device_id)
    if (machine) setDialog({ kind: 'versions', machineKey: machine.key })
  }, [machines])

  /** 移除 = 这个账号不再用这台机器;用 SSH 装上的,这台电脑也不再记得怎么连过去。 */
  const removeDevice = useCallback(async (device: Device): Promise<void> => {
    try {
      await remove(device.device_id, { cascade: agents.agents.length > 0 })
      await forget(device.device_id)
    } catch (err) {
      log.error({ err: String((err as Error)?.message ?? err), deviceId: device.device_id }, 'remove device failed')
      throw err
    }
  }, [remove, forget, agents.agents.length])

  const confirmRemove = async () => {
    if (dialog?.kind !== 'remove') return
    const { devices, machineKey } = dialog
    setDialog({ kind: 'remove', devices, removing: true, failed: '', machineKey })
    const left = [...devices]
    try {
      while (left.length) { await removeDevice(left[0]!); left.shift() }
      back(machineKey)
    }
    // 删到一半失败:已删的不再列,重试只删剩下的。
    catch (error) { setDialog({ kind: 'remove', devices: left, removing: false, failed: messageForUser(error), machineKey }) }
  }

  const configurationActions = useMemo<DeviceConfigurationActions>(() => ({
    remove: openRemove,
    uninstall: openUninstall,
    canUninstall: device => !!addressOf(device.device_id) && device.capabilities.host_kind === 'server',
  }), [openRemove, openUninstall, addressOf])

  const versionsMachine = dialog?.kind === 'versions' ? versionsOf(dialog.machineKey) : undefined
  // 确认页说的是哪一台:整台机器(它的每个版本都在删除之列)说机器,否则说那个版本。
  const removing = (() => {
    if (dialog?.kind !== 'remove' || dialog.devices.length === 0) return null
    const machine = deviceMachineFor(machines, dialog.devices[0]!.device_id)
    const whole = !machine || machine.configurations.every(device => dialog.devices.some(d => d.device_id === device.device_id))
    return { ...dialog, device: whole && machine ? machine.device : dialog.devices[0]!, version: !whole }
  })()
  const dialogs = <>
    {versionsMachine && versionsMachine.configurations.length > 1 && (
      <Sheet
        onClose={() => setDialog(null)}
        desktopWidth="400px"
        desktopMaxHeight="80vh"
        mobileFitContent
        ariaLabel={t('devices.remove.versions.title', { name: versionsMachine.device.label })}
        testId="settings-device-versions-dialog"
        zIndex="var(--z-settings-modal)"
      >
        <div className="flex flex-col gap-3 overflow-y-auto p-[18px]">
          <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('devices.remove.versions.title', { name: versionsMachine.device.label })}</div>
          <DeviceMachineConfigurations devices={versionsMachine.configurations} actions={configurationActions} />
        </div>
      </Sheet>
    )}

    {removing && (
      <DeviceRemoveDialog
        device={removing.device}
        removesVersion={removing.version}
        model={deviceRowModel(removing.device, addressOf(removing.device.device_id))}
        replacedBy={supersededBy(machines.map(machine => machine.device)).get(removing.device.device_id) ?? null}
        agents={agents}
        onCascadeChange={(value) => setAgents((s) => ({ ...s, cascadeChecked: value }))}
        removing={removing.removing}
        failed={removing.failed}
        onCancel={() => back(removing.machineKey)}
        onConfirm={() => void confirmRemove()}
      />
    )}

    {dialog?.kind === 'uninstall' && (
      <ServerUninstallDialog
        device={dialog.device}
        address={addressOf(dialog.device.device_id) ?? dialog.device.label}
        agents={agents}
        onCascadeChange={(value) => setAgents((s) => ({ ...s, cascadeChecked: value }))}
        onRemove={() => removeDevice(dialog.device)}
        onRemoveOnly={() => setDialog({ kind: 'remove', devices: [dialog.device], removing: false, failed: '', machineKey: dialog.machineKey })}
        onClose={() => back(dialog.machineKey)}
      />
    )}
  </>

  return { addressOf, openRemove, openRemoveDevices, openUninstall, openVersions, configurationActions, dialogs }
}
