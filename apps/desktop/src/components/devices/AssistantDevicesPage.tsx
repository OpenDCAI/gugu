/**
 * #7199 助理 App「能力 · 设备」(owner 10-15 定落在助理 App 里):
 * - 头一句「让 X 帮你操作以下设备」,X = 个人助理的名字;
 * - 只列人自己的设备:它住的那台云端宿主不在这里(owner 10-15「云电脑对用户完全不可见」);
 * - 本机在最上,再其次在线的、离线的;每台写在线 / 离线,手机另标「非全天可用」(规则见 lib/deviceAvailability);
 *   本机名字旁一个「本机」;
 * - 每台一句开了哪几项,点进去是那台的「能做的事」(与「设置 → 设备」同一页,❌ 另写一份授权页);
 * - 底下「连接更多设备」:各平台怎么装、怎么连(ConnectMoreDevices)。
 * 这是壳那棵树的组件:由 AssistantShellHost 画进助理 App 留的「devices」格子(会话页拿不到壳的设备 store)。
 * 用壳的设置原语(与同一页「聊天工具」那一格同一个样子),❌ 混用会话页那张 Tailwind 表的类名(两张表同名不同值)。
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { useDevicesStore } from '../../store/devicesContext'
import { sortAssistantDevices } from '../../lib/devicesSort'
import { deviceKind, type DeviceRowKind } from '../../lib/deviceRowModel'
import { deviceAvailability, usableActionGroups } from '../../lib/deviceAvailability'
import { formatRelativeTime } from '../../lib/relativeTime'
import { cn } from '../../lib/cn'
import { withoutAssistantHome } from '../../lib/assistantHome'
import { ChevronLeft, ChevronRight, Monitor, Server } from '@/lib/icons'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { DeviceActionsPage } from '../settings/DeviceActionsPage'
import { useThisDeviceState } from '../../hooks/useThisDeviceActions'
import { SettingsGroup, SettingsPage, SettingsRow } from '../settings/SettingsPrimitives'
import { PhoneDeviceActionsPage } from '../../mobile/phone-device/PhoneDeviceActionsPage'
import { ConnectMoreDevices } from './ConnectMoreDevices'
import { PhoneGlyph } from './assistantDeviceUi'
import { useDeviceActionGroupText } from '../settings/deviceActionGroupText'

export function AssistantDevicesPage({ cloudDeviceId, assistantName }: { cloudDeviceId: string | null; assistantName: string }) {
  const { t } = useTranslation('settings')
  const groupText = useDeviceActionGroupText()
  const { devices, phones, cloudComputer } = useDevicesStore()
  const snapshot = cloudComputer?.snapshot ?? null
  const cloudId = cloudDeviceId ?? snapshot?.deviceId ?? null
  const all = useMemo(() => sortAssistantDevices(withoutAssistantHome([...devices, ...(phones ?? [])], cloudId)), [devices, phones, cloudId])
  const { state: thisActions } = useThisDeviceState()
  const [open, setOpen] = useState<string | null>(null)

  const opened = open ? all.find((d) => d.device_id === open) ?? null : null
  if (opened?.is_current_device && isPhoneDevice(opened)) {
    return (
      <SettingsPage data-testid="assistant-this-phone-actions">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(null)} data-testid="assistant-devices-back">
            <ChevronLeft size={16} />
            {t('devices.deviceActions.back')}
          </Button>
          <div className="text-[length:var(--font-title)] font-medium">{t('devices.assistantPage.phoneTitle')}</div>
        </div>
        <PhoneDeviceActionsPage />
      </SettingsPage>
    )
  }
  if (opened) return <DeviceActionsPage device={opened} isThisDevice={opened.is_current_device === true} onBack={() => setOpen(null)} />

  const groupNames = (groups: readonly string[]) => groups.map((g) => groupText.name(g)).join('、')
  /** 这台开了哪几项;没登记动作清单(老版本、Windows / Linux 上的咕咕)= null,这一行就不说、也不能点。 */
  const grants = (device: Device): string | null => {
    if (device.is_current_device && !isPhoneDevice(device)) {
      if (!thisActions) return t('devices.assistantPage.reading')
      if (!thisActions.supported) return null
      const on = thisActions.groups.filter((g) => g.connected).map((g) => groupText.name(g.id))
      return on.length ? t('devices.assistantPage.granted', { list: on.join('、') }) : t('devices.assistantPage.noneGranted')
    }
    const usable = usableActionGroups(device)
    if (!usable) return null
    return usable.length ? t('devices.assistantPage.granted', { list: groupNames(usable) }) : t('devices.assistantPage.noneGranted')
  }

  return (
    <SettingsPage data-testid="assistant-devices">
      {/* 页标题由助理 App 的页头(PageHead)画;这一组只带头一句说明,与「聊天工具」页同一个版式。 */}
      <SettingsGroup
        note={assistantName ? t('devices.assistantPage.note', { name: assistantName }) : t('devices.assistantPage.noteNoName')}
      >
        {all.length === 0 && <SettingsRow description={t('devices.assistantPage.empty')} />}
        {all.map((device) => {
          const kind = deviceKind(device, cloudId)
          const summary = grants(device)
          return (
            <DeviceItem
              key={device.device_id}
              device={device}
              kind={kind}
              summary={summary}
              onOpen={summary !== null ? () => setOpen(device.device_id) : undefined}
            />
          )
        })}
      </SettingsGroup>
      <ConnectMoreDevices />
    </SettingsPage>
  )
}

function DeviceItem({
  device,
  kind,
  summary,
  onOpen,
}: {
  device: Device
  kind: DeviceRowKind
  summary: string | null
  onOpen?: () => void
}) {
  const { t } = useTranslation('settings')
  const lit = device.is_online
  const status = device.is_online
      ? t('devices.online')
      : (() => {
          const seen = formatRelativeTime(device.last_seen_at, { dateAfterDays: 30 })
          return seen ? t('devices.lastSeen', { time: seen }) : t('devices.offline')
        })()
  const availability = deviceAvailability(kind, device)
  const showKind = kind === 'desktop' || kind === 'server' || kind === 'phone'
  return (
    <SettingsRow
      data-testid={`assistant-device-${device.device_id}`}
      data-kind={kind}
      leading={<KindGlyph kind={kind} phone={isPhoneDevice(device)} />}
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{device.label}</span>
          {device.is_current_device && <Chip tone="accent">{t('devices.current')}</Chip>}
        </span>
      )}
      description={(
        <span className="flex min-w-0 items-baseline gap-[6px]">
          {/* 状态点:在线 = live 蓝(design.md 唯一的 accent),离线退成最淡一档 —— 与「设置 → 设备」同一个点。 */}
          <span aria-hidden className={cn('size-[7px] shrink-0 translate-y-[-1px] rounded-[var(--radius-circle)]', lit ? 'bg-live' : 'bg-[var(--faint-fg)]')} />
          {/* 窄屏折行,❌ 截成省略号:「已授权:日历、定位」是这一行要说的事(手机宽度截图实测被截掉)。 */}
          <span className="min-w-0">{[status, showKind ? t(`devices.kind.${kind}`) : null, summary].filter(Boolean).join(' · ')}</span>
        </span>
      )}
      control={(availability || onOpen) ? (
        <span className="flex items-center gap-2">
          {availability && (
            <Chip
              title={t(availability === 'allDay' ? 'devices.assistantPage.allDayHint' : 'devices.assistantPage.notAllDayHint')}
              data-testid="assistant-device-availability"
            >
              {t(availability === 'allDay' ? 'devices.assistantPage.allDay' : 'devices.assistantPage.notAllDay')}
            </Chip>
          )}
          {onOpen && <ChevronRight size={16} />}
        </span>
      ) : undefined}
      onClick={onOpen}
    />
  )
}

function KindGlyph({ kind, phone }: { kind: DeviceRowKind; phone: boolean }) {
  if (phone) return <PhoneGlyph />
  if (kind === 'server') return <Server size={18} />
  return <Monitor size={18} />
}
