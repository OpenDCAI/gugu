import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { Button } from '@/components/ui/Button'
import { ChevronRight, Monitor } from '@/lib/icons'
import { deviceAcceptsWork } from '@gugu/core/cloud/cloudComputer'
import { useDevicesStore } from '@/store/devicesContext'
import { formatRelativeTime } from '@/i18n/format'
import { AgentWatchNote, AgentWatchScreen } from './AgentWatchChrome'
import { LiveGlyph } from './StatusGlyph'
import { sessionListFromDigest } from '@/session/shared/remote-sessions/session-list-sync'
import { isAssistantSession } from '@/session/renderer/features/assistant/assistant-lineage'
import { usePhoneAssistantIdentity } from '../assistant/phoneAssistantIdentity'
import { useMachineLabel } from './useMachineLabel'
import { visibleMachines } from './machine-list'

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
}: {
  onBack: () => void
  onOpenDevice: (device: Device) => void
}) {
  const { t } = useTranslation('main')
  const { devices: allDevices, loading, error } = useDevicesStore()
  const { isHome } = useMachineLabel()
  // #7199 个人助理住的那台不列(规定「它住在哪」):那台不接人开的任务。
  const devices = visibleMachines(allDevices, isHome)

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
        />
      ) : null}

      {devices.length === 0 && loading ? (
        <div className="gg-aw-placeholder">{t('agentWatch.machines.loading')}</div>
      ) : null}

      {devices.length === 0 && !loading && !error ? (
        <div className="gg-aw-placeholder">
          {t('agentWatch.machines.empty')}
        </div>
      ) : null}

      <div className="gg-aw-list">
        {devices.map((device) => (
          <MachineCard
            key={device.device_id}
            device={device}
            onOpen={onOpenDevice}
            disabled={!deviceAcceptsWork(device)}
          />
        ))}
      </div>
    </AgentWatchScreen>
  )
}

/**
 * 一台机器。形制照抄 orca 手机端的 `MobileHostCard`：
 * 左边一个圆角图标块，右边名字 + 一行「状态点 + 状态词」，离线时再补一行「最后一次见到」。
 * 状态只由那个点和文字表达 —— ❌ 不用彩色胶囊，那在一列里全是色块。
 */
function MachineCard({
  device,
  onOpen,
  disabled,
}: {
  device: Device
  onOpen: (device: Device) => void
  /** 离线的机器:照画,但点不动 —— 它不在线就没法在它上面起进程。 */
  disabled?: boolean
}) {
  const { t } = useTranslation('main')
  const online = device.is_online
  const seen = formatRelativeTime(device.last_seen_at)
  // #7199 个人助理自己的会话不算任务(它不住任务区)。
  const assistant = usePhoneAssistantIdentity()
  const count = sessionListFromDigest(device.session_digest).sessions.filter((session) => !isAssistantSession(session, assistant?.id)).length

  return (
    <Button
      variant="ghost"
      size="option"
      className="gg-aw-machine"
      data-device-id={device.device_id}
      data-online={online ? 'true' : 'false'}
      disabled={disabled}
      onClick={() => onOpen(device)}
    >
      <span className="gg-aw-machine-icon" data-online={online ? 'true' : 'false'}>
        <Monitor />
      </span>
      <span className="gg-aw-machine-main">
        <span className="gg-aw-item-title">{device.label}</span>
        <span className="gg-aw-item-meta">
          <LiveGlyph state={online ? 'online' : 'offline'} />
          <span>{online ? t('agentWatch.machines.online') : t('agentWatch.machines.offline')}</span>
          {!online && seen ? (
            <>
              <span className="gg-aw-item-sep">·</span>
              <span>{seen}</span>
            </>
          ) : null}
        </span>
        {count > 0 ? (
          <span className="gg-aw-item-meta gg-aw-machine-sub">
            <span>{t('agentWatch.machines.sessionCount', { count })}</span>
          </span>
        ) : null}
      </span>
      <span className="gg-aw-machine-trailing"><ChevronRight /></span>
    </Button>
  )
}
