import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { Button } from '@/components/ui/Button'
import { ListRowContent } from '@/components/ui/ListRow'
import { ChevronRight, Monitor, MonitorSmartphone } from '@/lib/icons'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { deviceAcceptsWork } from '@gugu/core/cloud/cloudComputer'
import { useDevicesStore } from '@/store/devicesContext'
import { formatRelativeTime } from '@/i18n/format'
import { AgentWatchNote, AgentWatchScreen } from './AgentWatchChrome'
import { LiveGlyph } from './StatusGlyph'
import { sessionListFromDigest } from '@/session/shared/remote-sessions/session-list-sync'
import { isAssistantSession } from '@/session/renderer/features/assistant/assistant-lineage'
import { usePhoneAssistantIdentity } from '../assistant/phoneAssistantIdentity'
import { useMachineLabel } from './useMachineLabel'
import { visibleMachines, workspaceDevices } from './machine-list'
import { DeviceDirectoryRetry } from './DeviceDirectoryRetry'
import { PhoneHostSetupEntry } from './PhoneHostSetupEntry'
import { phoneAgentAvailable } from '../local-agent/nativeAgent'
import './task-flow-catalog'

/**
 * 选机器页:新建会话的第一步(「在哪台机器上」)。
 *
 * #7199 起手机底栏那一格(「项目」)按项目列,机器不再是上一层 —— 这张页只剩「新建会话先选机器」这一件事,
 * 由项目页右上角的 + 与联系人页的「新建 Agent」推进来。
 *
 * 复用 DevicesProvider —— 「这个账号有哪些机器、哪台在线」全 app 只有那一份事实源
 * (#1749);这里再拉一次列表就会出现「设置里显示在线、这里显示离线」的两份真相。
 *
 * 离线的机器照画但**点不动**:建会话要在那台机器上起进程,它不在线就建不了。
 * ❌ 不另画一张选机器页:那就是第二份机器列表,归并规则、状态点、最后在线时间三样都会再漂一次。
 */
export function MachinesPage({
  onBack,
  onOpenDevice,
  computersOnly = false,
}: {
  onBack: () => void
  onOpenDevice: (device: Device) => void
  computersOnly?: boolean
}) {
  const { t } = useTranslation('main')
  const { t: tFlow } = useTranslation('mobileTaskFlow')
  const { devices: allDevices, phones = [], loading, error } = useDevicesStore()
  const { isHome, label: machineLabel } = useMachineLabel()
  // #7199 个人助理住的那台不列(规定「它住在哪」):那台不接人开的任务。
  const candidates = [...new Map([...allDevices, ...phones].map((device) => [device.device_id, device])).values()]
  const devices = visibleMachines(computersOnly ? workspaceDevices(candidates) : candidates, isHome)

  return (
    <AgentWatchScreen
      title={t('agentWatch.create.pickMachine')}
      onBack={onBack}
      testId="agent-watch-pick-machine"
    >
      {/*
        * 手里已经有上次那份 ⇒ ❌ 不画红。owner 2026-09-08 定的标准:
        * 「不应该是先报一个红色的报错、等我刷新之后才显示出来」——
        * 屏幕上那份仍然是真的，只是没更新；红框该留给「什么都没有、也读不出来」。
        */}
      {error && devices.length === 0 ? (
        <AgentWatchNote
          title={t('agentWatch.machines.loadFailed')}
          detail={error}
          tone="danger"
          testId="agent-watch-machines-error"
        >
          <DeviceDirectoryRetry />
        </AgentWatchNote>
      ) : null}

      {devices.length === 0 && loading ? (
        <div className="gg-aw-placeholder">{t('agentWatch.machines.loading')}</div>
      ) : null}

      {devices.length === 0 && !loading && !error ? (
        <div className="gg-aw-placeholder">
          <div>{phoneAgentAvailable() ? tFlow('noHost') : t('agentWatch.machines.empty')}</div>
          <PhoneHostSetupEntry />
        </div>
      ) : null}

      <div className="gg-aw-list">
        {devices.map((device) => (
          <MachineCard
            key={device.device_id}
            device={device}
            label={machineLabel(device)}
            onOpen={onOpenDevice}
            disabled={!deviceAcceptsWork(device)}
          />
        ))}
      </div>
    </AgentWatchScreen>
  )
}

/** A shared entity row; status and last seen are backed by the device record. */
function MachineCard({
  device,
  label,
  onOpen,
  disabled,
}: {
  device: Device
  label: string
  onOpen: (device: Device) => void
  /** 离线的机器:照画,但点不动 —— 它不在线就没法在它上面起进程。 */
  disabled?: boolean
}) {
  const { t } = useTranslation('main')
  const online = device.is_online
  const waking = device.cloud_computer === 'waking'
  const connectable = device.cloud_computer === 'asleep' || waking
  const { t: tFlow } = useTranslation('mobileTaskFlow')
  const seen = formatRelativeTime(device.last_seen_at)
  // #7199 个人助理自己的会话不算任务(它不住任务区)。
  const assistant = usePhoneAssistantIdentity()
  const count = sessionListFromDigest(device.session_digest).sessions.filter((session) => !isAssistantSession(session, assistant?.id)).length

  return (
    <Button
      variant="ghost"
      size="option"
      className="gg-list-row gg-row gg-aw-machine"
      data-mobile=""
      data-device-id={device.device_id}
      data-online={online ? 'true' : 'false'}
      disabled={disabled}
      onClick={() => onOpen(device)}
    >
      <ListRowContent title={label} leading={
        <span className="gg-aw-machine-icon" data-online={online ? 'true' : 'false'}>
          {isPhoneDevice(device) ? <MonitorSmartphone /> : <Monitor />}
        </span>
      } meta={count > 0 ? t('agentWatch.machines.sessionCount', { count }) : undefined} subtitle={
        <span className="gg-aw-item-meta">
          <LiveGlyph state={online ? 'online' : waking ? 'busy' : 'offline'} />
          <span>{online ? t('agentWatch.machines.online') : connectable ? tFlow(waking ? 'connecting' : 'readyToConnect') : t('agentWatch.machines.offline')}</span>
          {!online && !connectable && seen ? (
            <>
              <span className="gg-aw-item-sep">·</span>
              <span>{seen}</span>
            </>
          ) : null}
        </span>
      } />
      <span className="gg-aw-machine-trailing"><ChevronRight /></span>
    </Button>
  )
}
