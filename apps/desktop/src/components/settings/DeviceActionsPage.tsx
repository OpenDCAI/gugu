/**
 * #7199「设置 → 设备 → 这台电脑能做的事」:
 * - 列表:「已授权 / 可用」两组,一行 = 图标 + 名称 + 一行说明 + ›,连没连全看所在分组(行上不放按钮);
 *   底下是「全部拒绝」与「最近调用」(这台电脑最近被助理调用过什么)。
 * - 点一行进详情:大图标 + 说明 + 「连接」(一个按钮兼管系统授权,第一次会弹系统的授权框;系统不让就当场说去哪打开)/ 右上「断开连接」;
 *   「xx 连接」里是状态与连接时间;「能做的事」里每个动作一个开关(「工具权限」),关掉的那一个助理就调不了。
 * - 别的设备:只读显示它登记的动作与可不可用;要开关得在那台设备上改(授权只存在那台设备上)。
 *
 * 两个落点:「助理」App 的「能力 · 设备」页挂 DeviceCapabilitiesPage(按 deviceId,返回键可选);
 * 「设置 → 设备」里的兼容入口挂 DeviceActionsPage。分组名用 useDeviceActionGroupText(文案在 settings 命名空间)。
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import type { DeviceActionManifestEntry } from '@gugu/core/shared/deviceActions'
import {
  DEVICE_ACTIONS_CHANNELS,
  type DeviceActionsActionView,
  type DeviceActionsConnectResult,
  type DeviceActionsGroupView,
  type DeviceActionsRecentCall,
  type DeviceActionsState,
} from '../../lib/deviceActionsIpc'
import { desktopIpc } from '../../platform/desktopIpc'
import { platform } from '../../platform'
// 「这台电脑能做的事」的现读状态:与助理 App「能力 · 设备」那一行(AssistantDevicesPage)共用一份。
import { useThisDeviceState } from '../../hooks/useThisDeviceActions'
import { formatRelativeTime } from '../../lib/relativeTime'
import { useDevicesStore } from '../../store/devicesContext'
import {
  Bell,
  CalendarClock,
  Checklist,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Compass,
  Download,
  File,
  FileText,
  Focus,
  Folder,
  Gauge,
  Link,
  Mail,
  MessageCircle,
  Monitor,
  ScanSearch,
  Settings,
  SquareTerminal,
  Users,
  Zap,
  type IconComponent,
} from '@/lib/icons'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow, Toggle } from './SettingsPrimitives'
import { useDeviceActionGroupText } from './deviceActionGroupText'

const FALLBACK_ICONS: Record<string, IconComponent> = {
  calendar: CalendarClock,
  reminders: Checklist,
  contacts: Users,
  notes: FileText,
  mail: Mail,
  messages: MessageCircle,
  'files.desktop': Monitor,
  'files.documents': File,
  'files.downloads': Download,
  'files.other': Folder,
  ghost: Focus,
  screen: ScanSearch,
  clipboard: Clipboard,
  location: Compass,
  device: Gauge,
  system: Settings,
  shell: SquareTerminal,
  notification: Bell,
  url: Link,
  shortcuts: Zap,
}

/** 两档:列表行 28px、详情页大图 48px。尺寸走类名,❌ 行内 style(ui 视觉规范的行内样式计数)。 */
const ICON_BOX = { row: { px: 28, box: 'size-7', glyph: 16 }, hero: { px: 48, box: 'size-12', glyph: 26 } } as const

export function GroupIcon({ group, size }: { group: { id: string; icon?: string }; size: keyof typeof ICON_BOX }) {
  const dims = ICON_BOX[size]
  if (group.icon) return <img src={group.icon} alt="" width={dims.px} height={dims.px} className="shrink-0" draggable={false} />
  const Icon = FALLBACK_ICONS[group.id] ?? Settings
  return (
    <span className={`grid shrink-0 place-items-center rounded-[var(--radius-control)] bg-foreground/[0.06] ${dims.box}`}>
      <Icon size={dims.glyph} />
    </span>
  )
}

export function DeviceActionsPage({ device, isThisDevice, onBack }: { device: Device; isThisDevice: boolean; onBack?: () => void }) {
  const { t } = useTranslation('settings')
  const ipc = desktopIpc()
  if (isThisDevice && ipc) return <ThisDeviceActions onBack={onBack} />
  return (
    <SettingsPage data-testid="settings-device-actions">
      <PageHeader title={t('devices.deviceActions.otherTitle', { name: device.label })} backLabel={t('devices.deviceActions.back')} onBack={onBack} />
      <OtherDeviceActions device={device} />
    </SettingsPage>
  )
}

/**
 * 「助理」App · 能力 · 设备 里的一页:一台设备能被助理做的事。deviceId 缺省 = 这台电脑。
 * 这台电脑 = 可连接 / 断开 / 逐个开关;别的设备 = 只读(授权只存在那台设备上)。onBack 不给就不画返回键(外壳自己有导航)。
 */
export function DeviceCapabilitiesPage({ deviceId, onBack }: { deviceId?: string; onBack?: () => void }) {
  const { t } = useTranslation('settings')
  const { devices, loading } = useDevicesStore()
  const device = deviceId ? devices.find((d) => d.device_id === deviceId) ?? null : devices.find((d) => d.is_current_device) ?? null
  if (!device) {
    // 这台电脑在设备列表登记上之前,本机的授权页照样能用(授权只在本机)。
    if (!deviceId && desktopIpc()) return <ThisDeviceActions onBack={onBack} />
    return <SettingsPage data-testid="settings-device-actions"><SettingsNote>{loading ? t('devices.loading') : t('devices.deviceActions.otherNone')}</SettingsNote></SettingsPage>
  }
  return <DeviceActionsPage device={device} isThisDevice={device.is_current_device === true} onBack={onBack} />
}

function PageHeader({ title, subtitle, backLabel, onBack, trailing, testId }: { title: ReactNode; subtitle?: ReactNode; backLabel: string; onBack?: () => void; trailing?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} data-testid={testId ?? 'settings-device-actions-back'}>
            <ChevronLeft size={16} />
            {backLabel}
          </Button>
        )}
        <div className="min-w-0 flex-1 truncate text-[length:var(--font-title)] font-medium">{title}</div>
        {trailing}
      </div>
      {subtitle ? <SettingsNote>{subtitle}</SettingsNote> : null}
    </div>
  )
}

/**
 * `bare` = 嵌在别人的页里(助理 App「连接应用 · 本机」那一段):不画自己的标题,详情页的返回写回「连接应用」。
 */
export function ThisDeviceActions({ onBack, bare = false }: { onBack?: () => void; bare?: boolean }) {
  const { t } = useTranslation('settings')
  const text = useDeviceActionGroupText()
  const { state, reload } = useThisDeviceState()
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  const header = bare ? null : (
    <PageHeader
      title={t('devices.deviceActions.thisTitle')}
      subtitle={t('devices.deviceActions.thisSubtitle')}
      backLabel={t('devices.deviceActions.back')}
      onBack={onBack}
    />
  )
  if (!state) return <SettingsPage data-testid="settings-device-actions">{header}<SettingsNote>{t('devices.loading')}</SettingsNote></SettingsPage>
  if (!state.supported) return <SettingsPage data-testid="settings-device-actions">{header}<SettingsNote>{t('devices.deviceActions.unsupported')}</SettingsNote></SettingsPage>

  const selected = openGroup ? state.groups.find((g) => g.id === openGroup) ?? null : null
  if (selected) return <GroupDetail group={selected} denyAll={state.denyAll} onBack={() => setOpenGroup(null)} reload={reload} backLabel={bare ? t('devices.connectors.back') : undefined} />

  const connected = state.groups.filter((g) => g.connected)
  const available = state.groups.filter((g) => !g.connected)
  const row = (group: DeviceActionsGroupView) => (
    <SettingsRow
      key={group.id}
      data-testid={`settings-device-action-group-${group.id}`}
      leading={<GroupIcon group={group} size="row" />}
      title={(
        <span className="flex items-center gap-2">
          {text.name(group.id)}
          {group.connected && group.blocked && <Chip tone="warn">{t(group.blocked.reason === 'os_permission' ? 'devices.deviceActions.statusBlocked' : 'devices.deviceActions.statusUnsupported')}</Chip>}
        </span>
      )}
      description={text.description(group.id)}
      control={<ChevronRight size={16} />}
      onClick={() => setOpenGroup(group.id)}
    />
  )

  return (
    <SettingsPage data-testid="settings-device-actions">
      {header}
      <SettingsNote>{t('devices.deviceActions.thisNote')}</SettingsNote>
      {state.denyAll && <SettingsNote tone="danger" data-testid="settings-device-actions-deny-all-on">{t('devices.deviceActions.denyAllOn')}</SettingsNote>}
      {connected.length > 0 && <SettingsGroup title={t('devices.deviceActions.connected')} data-testid="settings-device-actions-connected">{connected.map(row)}</SettingsGroup>}
      {available.length > 0 && <SettingsGroup title={t('devices.deviceActions.available')} data-testid="settings-device-actions-available">{available.map(row)}</SettingsGroup>}
      <SettingsGroup>
        <SettingsRow
          title={t('devices.deviceActions.denyAll')}
          description={t('devices.deviceActions.denyAllHint')}
          control={(
            <Toggle
              checked={state.denyAll}
              ariaLabel={t('devices.deviceActions.denyAll')}
              onChange={(on) => { void desktopIpc()?.invoke(DEVICE_ACTIONS_CHANNELS.setDenyAll, on).then(reload) }}
            />
          )}
          data-testid="settings-device-actions-deny-all"
        />
      </SettingsGroup>
      <RecentCalls state={state} />
    </SettingsPage>
  )
}

function RecentCalls({ state }: { state: DeviceActionsState }) {
  const { t, i18n } = useTranslation('settings')
  const text = useDeviceActionGroupText()
  const english = i18n.language.startsWith('en')
  /** 这个动作在设置页上属于哪一组(文件动作四个根共用,叫「文件」)。 */
  const groupName = (action: string) => {
    const group = state.groups.find((g) => g.actions.some((a) => a.name === action))
    return group ? text.name(group.section === 'files' ? 'files' : group.id) : action
  }
  // 被拦下的三种给人看的话;其余(参数不对、执行出错、超时)原样给出那条说明。
  const failed = (call: DeviceActionsRecentCall) =>
    call.code === 'not_granted' ? t('devices.deviceActions.recentNotAllowed', { group: groupName(call.action) })
      : call.code === 'os_permission' ? t('devices.deviceActions.recentOsPermission', { group: groupName(call.action) })
        : call.code === 'unsupported' ? t('devices.deviceActions.recentUnsupported')
          : t('devices.deviceActions.recentFailed', { message: call.message ?? call.code ?? '' })
  return (
    <SettingsGroup title={t('devices.deviceActions.recent')} data-testid="settings-device-actions-recent">
      {state.recent.length === 0
        ? <SettingsRow description={t('devices.deviceActions.recentEmpty')} />
        : state.recent.map((call) => (
            <SettingsRow
              key={call.callId}
              title={english ? call.titleEn : call.title}
              description={[
                formatRelativeTime(call.startedAt),
                call.callerName ? t('devices.deviceActions.byCaller', { name: call.callerName }) : null,
                call.ok === undefined
                  ? t('devices.deviceActions.recentRunning')
                  : call.ok
                    ? t('devices.deviceActions.recentOk')
                    : call.code === 'needs_confirmation'
                      ? t('devices.deviceActions.recentNeedsConfirmation')
                      : failed(call),
              ].filter(Boolean).join(' · ')}
            />
          ))}
    </SettingsGroup>
  )
}

function GroupDetail({ group, denyAll, onBack, reload, backLabel }: { group: DeviceActionsGroupView; denyAll: boolean; onBack: () => void; reload: () => void; backLabel?: string }) {
  const { t, i18n } = useTranslation('settings')
  const text = useDeviceActionGroupText()
  const english = i18n.language.startsWith('en')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ message: string; settingsUrl?: string; restart?: true } | null>(null)
  const name = text.name(group.id)

  const connect = useCallback(async () => {
    const ipc = desktopIpc()
    if (!ipc) return
    setBusy(true)
    setFailure(null)
    try {
      const result = (await ipc.invoke(DEVICE_ACTIONS_CHANNELS.connect, group.id)) as DeviceActionsConnectResult
      if (!result.ok) setFailure({ message: result.message, ...(result.settingsUrl ? { settingsUrl: result.settingsUrl } : {}), ...(result.restart ? { restart: true } : {}) })
    } finally {
      setBusy(false)
      reload()
    }
  }, [group.id, reload])

  const disconnect = useCallback(async () => {
    await desktopIpc()?.invoke(DEVICE_ACTIONS_CHANNELS.disconnect, group.id)
    setFailure(null)
    reload()
  }, [group.id, reload])

  const settingsUrl = failure?.settingsUrl ?? (group.blocked?.reason === 'os_permission' ? group.settingsUrl : undefined)
  const problem = failure?.message ?? (group.connected ? group.blocked?.message : group.blocked?.reason === 'unsupported' ? group.blocked.message : undefined)
  const enabledCount = group.actions.filter((a) => a.enabled).length
  const overrides = group.actions.length - enabledCount

  const status = !group.connected
    ? { tone: undefined, label: t('devices.deviceActions.statusNotConnected') }
    : group.blocked
      ? { tone: 'warn' as const, label: t(group.blocked.reason === 'os_permission' ? 'devices.deviceActions.statusBlocked' : 'devices.deviceActions.statusUnsupported') }
      : { tone: 'ok' as const, label: t('devices.deviceActions.statusConnected') }

  return (
    <SettingsPage data-testid={`settings-device-action-detail-${group.id}`}>
      <PageHeader
        title={name}
        backLabel={backLabel ?? t('devices.deviceActions.thisTitle')}
        onBack={onBack}
        testId="settings-device-action-detail-back"
        trailing={group.connected
          ? (
              <Button variant="secondary" size="sm" className="text-[var(--danger-fg,#d63838)]" onClick={() => void disconnect()} data-testid={`settings-device-action-disconnect-${group.id}`}>
                {t('devices.deviceActions.disconnect')}
              </Button>
            )
          : undefined}
      />

      <div className="gg-settings-card window-no-drag-region flex flex-col items-center gap-2 px-4 py-6 text-center">
        <GroupIcon group={group} size="hero" />
        <div className="font-medium">{name}</div>
        <div className="max-w-[420px] text-[var(--muted-fg)]">{text.description(group.id)}</div>
        {!group.connected && (
          <Button
            variant="primary"
            size="sm"
            className="mt-1 rounded-full px-5"
            disabled={busy || group.blocked?.reason === 'unsupported'}
            onClick={() => void connect()}
            data-testid={`settings-device-action-connect-${group.id}`}
          >
            {busy ? t('devices.deviceActions.connecting') : t('devices.deviceActions.connect')}
          </Button>
        )}
        {problem && (
          <div className="mt-1 flex flex-col items-center gap-1 text-[var(--danger-fg,#d63838)]" data-testid="settings-device-action-connect-failed">
            <div>{failure ? t('devices.deviceActions.connectFailed', { message: problem }) : problem}</div>
            <div className="flex items-center gap-1">
              {settingsUrl && (
                <Button variant="ghost" size="sm" onClick={() => void desktopIpc()?.invoke(DEVICE_ACTIONS_CHANNELS.openSystemSettings, settingsUrl)}>
                  {t('devices.deviceActions.openSystemSettings')}
                </Button>
              )}
              {failure?.restart && platform.capabilities.appRelaunch && (
                <Button variant="ghost" size="sm" onClick={() => void platform.relaunchApp()} data-testid="settings-device-action-restart">
                  {t('devices.deviceActions.restartToApply')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <SettingsGroup title={t('devices.deviceActions.connection', { name })}>
        <SettingsRow
          title={t('devices.deviceActions.status')}
          control={<Chip tone={status.tone} data-testid={`settings-device-action-status-${group.id}`}>{status.label}</Chip>}
        />
        {group.connectedAt && (
          <SettingsRow title={t('devices.deviceActions.connectedAt')} control={<span className="text-[var(--muted-fg)]">{new Date(group.connectedAt).toLocaleString()}</span>} />
        )}
      </SettingsGroup>

      {group.actions.length > 0 && (
        <SettingsGroup
          title={(
            <span className="flex items-center gap-2">
              {t('devices.deviceActions.actionsTitle')}
              <span className="text-[var(--muted-fg)]">{t('devices.deviceActions.actionsCount', { on: enabledCount, total: group.actions.length })}</span>
            </span>
          )}
          note={t('devices.deviceActions.actionsNote')}
          footer={overrides > 0
            ? (
                <Button variant="ghost" size="sm" onClick={() => { void desktopIpc()?.invoke(DEVICE_ACTIONS_CHANNELS.resetOverrides).then(reload) }} data-testid="settings-device-action-reset-overrides">
                  {t('devices.deviceActions.resetOverrides')}
                </Button>
              )
            : undefined}
          data-testid={`settings-device-action-tools-${group.id}`}
        >
          {group.actions.map((action) => (
            <ActionRow key={action.name} action={action} english={english} disabled={!group.connected || denyAll} reload={reload} />
          ))}
        </SettingsGroup>
      )}
    </SettingsPage>
  )
}

function ActionRow({ action, english, disabled, reload }: { action: DeviceActionsActionView; english: boolean; disabled: boolean; reload: () => void }) {
  const { t } = useTranslation('settings')
  const policy = action.confirm === 'always' ? t('devices.deviceActions.confirmAlways') : action.confirm === 'on_conflict' ? t('devices.deviceActions.confirmOnConflict') : null
  return (
    <SettingsRow
      data-testid={`settings-device-action-tool-${action.name}`}
      title={(
        <span className="flex flex-wrap items-center gap-2">
          {english ? action.titleEn : action.title}
          <code className="text-[length:var(--font-caption)] text-[var(--muted-fg)]">{action.name}</code>
          {policy && <Chip>{policy}</Chip>}
          {action.unsupported && <Chip tone="warn">{t('devices.deviceActions.statusUnsupported')}</Chip>}
        </span>
      )}
      description={action.unsupported
        ? action.unsupported
        : <span title={action.description}>{action.description.length > 140 ? `${action.description.slice(0, 140)}…` : action.description}</span>}
      control={(
        <span className={disabled ? 'pointer-events-none opacity-40' : undefined}>
          <Toggle
            checked={action.enabled}
            ariaLabel={english ? action.titleEn : action.title}
            onChange={(enabled) => { void desktopIpc()?.invoke(DEVICE_ACTIONS_CHANNELS.setActionEnabled, { action: action.name, enabled }).then(reload) }}
          />
        </span>
      )}
    />
  )
}

function OtherDeviceActions({ device }: { device: Device }) {
  const { t } = useTranslation('settings')
  const text = useDeviceActionGroupText()
  const actions = device.capabilities?.actions?.actions ?? null
  const groups = useMemo(() => {
    const out = new Map<string, DeviceActionManifestEntry[]>()
    for (const a of actions ?? []) out.set(a.group, [...(out.get(a.group) ?? []), a])
    return [...out.entries()]
  }, [actions])
  if (!actions) return <SettingsNote>{t('devices.deviceActions.otherNone')}</SettingsNote>
  return (
    <>
      <SettingsNote>{t('devices.deviceActions.otherNote')}</SettingsNote>
      {!device.is_online && <SettingsNote tone="danger">{t('devices.deviceActions.otherOffline')}</SettingsNote>}
      <SettingsGroup>
        {groups.map(([group, list]) => {
          const on = list.some((a) => a.available)
          const reason = list.find((a) => !a.available)?.unavailable_reason
          return (
            <SettingsRow
              key={group}
              leading={<GroupIcon group={{ id: group }} size="row" />}
              title={text.name(group)}
              description={list.map((a) => a.title).join(' · ')}
              control={on
                ? <Chip tone="ok">{t('devices.deviceActions.availableNow')}</Chip>
                : <Chip>{t(`devices.deviceActions.unavailable.${reason ?? 'not_granted'}`)}</Chip>}
            />
          )
        })}
      </SettingsGroup>
    </>
  )
}
