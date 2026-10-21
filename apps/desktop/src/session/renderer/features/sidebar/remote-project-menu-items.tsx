import { Plus, Server } from '@/lib/icons'
import { observer } from 'mobx-react-lite'
import { useEffect } from 'react'
import { deviceScopeTrayDevices } from '@renderer/features/remote-hosts/device-scope-store'
import { machineAcceptsWork, machineMeta, orderMachines } from '@renderer/features/remote-hosts/machine-choice'
import { MachineLines, MachineTile } from '@renderer/features/remote-hosts/machine-picker'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { useNavigate } from '@renderer/lib/layout/navigation-provider'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@renderer/lib/ui/dropdown-menu'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { log } from '@renderer/utils/logger'

// #6264 侧栏「添加项目」菜单的第三项「使用远程文件夹 ›」(与「新建空白项目」「使用现有文件夹」三选一;
// owner 2026-09-25:机器直接平铺在菜单里「不好看」)。子菜单里每台机器一行,点它 = 在那台机器上挑文件夹
// (照 VS Code「Open Remote…」/ Zed 的远端项目),底下「添加一台机器…」。
// 挑文件夹的窗口里自带「新建文件夹」,所以「新建空白项目」在别的机器上也是这一步。
// 挑好 → 在那台机器上把它加成项目、打开项目页(与本机「打开文件夹」同一步,一套工作台)。
// 离线的机器照样列着、灰掉写「离线 · X 前」,❌ 从菜单里消失。
export const RemoteProjectMenuItems = observer(function RemoteProjectMenuItems() {
  const { translate } = useSessionMessages()
  const { navigate } = useNavigate()
  useEffect(() => remoteHostsStore.start(), [])
  const machines = orderMachines(
    deviceScopeTrayDevices(
      translate('task.deviceLocal'),
      [...remoteHostsStore.hosts.values()].map(({ device }) => ({
        device,
        connection: remoteHostsStore.connectionState(device.id)
      }))
    )
  ).filter((machine) => !machine.isLocal)

  const openOn = (deviceId: string, asleep: boolean) => {
    // #7199 睡着的云电脑:先叫醒它,醒了再在它上面挑文件夹(没叫醒的原因记在 store 里,侧栏那颗点照实说)。
    void (asleep ? remoteHostsStore.wakeCloudComputer(deviceId) : Promise.resolve(true))
      .then((awake) => (awake ? remoteHostsStore.pickFolder(deviceId, '~') : null))
      .then(async (path) => {
        if (!path) return
        remoteHostsStore.rememberRecentFolder(deviceId, path)
        const projectId = await remoteHostsStore.ensureProject(deviceId, path)
        navigate('project', { projectId })
      })
      .catch((error: unknown) => log.error('[sidebar] 在那台机器上加项目失败', error))
  }

  if (machines.length === 0 && !remoteHostsStore.canAddMachine) return null
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="sidebar-remote-folder">
        <Server className="size-3.5" />
        <span>{translate('sidebar.remoteFolder')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-60">
        {machines.length > 0 ? (
          <div className="max-h-60 overflow-y-auto">
            {machines.map((machine) => {
              const offline = !machineAcceptsWork(machine)
              return (
                <DropdownMenuItem
                  key={machine.id}
                  data-device-id={machine.id}
                  disabled={offline}
                  className="gap-3 py-1"
                  onClick={() => openOn(machine.id, machine.cloudComputer !== undefined)}
                >
                  <MachineTile machine={machine} solid={false} />
                  <MachineLines label={machine.label} meta={machineMeta(machine, translate, { withLink: true })} muted={offline} />
                </DropdownMenuItem>
              )
            })}
          </div>
        ) : null}
        {remoteHostsStore.canAddMachine ? (
          <>
            {machines.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onClick={() => remoteHostsStore.openAddMachine()} data-testid="sidebar-add-machine">
              <Plus className="size-3.5" />
              <span>{translate('task.deviceAdd')}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
})
