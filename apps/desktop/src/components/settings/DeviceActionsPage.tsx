import { useAssistantPanelBack } from '@/lib/assistantPanelPage'
/** Device pages summarize grants; only Settings → Permissions enables editing. */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import type { DeviceActionSummary } from '@gugu/core/shared/deviceActions'
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
import { messageForUser } from '../../lib/userFacingError'
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
import { reportAssistantAppChange } from '../assistant/assistant-app-client'
import { libraryDeviceId } from '../assistant/assistant-library-client'
import { cachedDevicesAccount } from '../../store/devicesCache'
import { UI_EVENTS } from '../../lib/uiEvents'
import { useSettingsDetail } from './SettingsDetailNavigation'
import { DeviceMachineConfigurations, type DeviceConfigurationActions } from '../devices/DeviceMachineConfigurations'

async function saveDevicePermission(channel: string, args: unknown, change: { action: string; enabled?: boolean; group?: string }): Promise<void> {
  const ipc = desktopIpc()
  if (!ipc) throw new Error('This device is unavailable')
  const ownerId = cachedDevicesAccount()
  await ipc.invoke(channel, args)
  const deviceId = libraryDeviceId(null)
  await reportAssistantAppChange(null, undefined, { resource: 'devices', operation: 'edited', section: 'permissions',
    id: deviceId ?? 'permission-settings', deviceId, after: change }, ownerId)
}

/** One error outlet for a committed permission change; success only refreshes real state. */
async function updateDevicePermission(
  args: Parameters<typeof saveDevicePermission>,
  reload: () => void,
  fail: (message: string | null) => void,
): Promise<void> {
  fail(null)
  try {
    await saveDevicePermission(...args)
    reload()
  } catch (error) {
    fail(messageForUser(error))
  }
}

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

export function DeviceActionsPage({ device, isThisDevice, onBack, embedded = false, panelNavigation = false, configurations, configurationActions }: { device: Device; isThisDevice: boolean; onBack?: () => void; embedded?: boolean; panelNavigation?: boolean; configurations?: readonly Device[]; configurationActions?: DeviceConfigurationActions }) {
  const { t } = useTranslation('settings')
  const ipc = desktopIpc()
  const [selectedVersionId, selectVersion] = useState<string | null>(null)
  const selected = configurations?.find(version => version.device_id === selectedVersionId) ?? device
  const selectedIsThisDevice = selected.device_id === device.device_id ? isThisDevice : selected.is_current_device === true
  const versions = <DeviceMachineConfigurations devices={configurations} actions={configurationActions} selectedDeviceId={selected.device_id} onSelect={version => selectVersion(version.device_id)} />
  if (selectedIsThisDevice && ipc) return <ThisDeviceActions onBack={onBack} panelNavigation={panelNavigation}>{versions}</ThisDeviceActions>
  return (
    <SettingsPage data-testid="settings-device-actions">
      {!embedded && <PageHeader panelNavigation={panelNavigation} navigationKey={`device:${device.device_id}`} title={t('devices.deviceActions.otherTitle', { name: device.label })} backLabel={t('devices.deviceActions.back')} onBack={onBack} />}
      {versions}
      <OtherDeviceActions device={selected} compact={embedded} />
    </SettingsPage>
  )
}

/** Compatibility route: local and remote device pages both summarize grants. */
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

function PageHeader({ title, subtitle, backLabel, onBack, trailing, testId, panelNavigation = false, navigationKey }: { panelNavigation?: boolean; navigationKey?: string; title: ReactNode; subtitle?: ReactNode; backLabel: string; onBack?: () => void; trailing?: ReactNode; testId?: string }) {
  useAssistantPanelBack(panelNavigation && onBack ? navigationKey ?? String(title) : null, onBack ?? (() => {}))
  if (panelNavigation) return <div className="flex flex-col gap-1"><div className="flex items-center gap-2"><h1 className="ta-page-title min-w-0 flex-1">{title}</h1>{trailing}</div>{subtitle ? <SettingsNote>{subtitle}</SettingsNote> : null}</div>
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

/** Only PermissionsSection opts into editing; legacy device routes stay read-only. */
export function ThisDeviceActions({ onBack, bare = false, panelNavigation = false, managePermissions = false, backLabel, children }: {
  onBack?: () => void; bare?: boolean; panelNavigation?: boolean; managePermissions?: boolean; backLabel?: string; children?: ReactNode
}) {
  const { t } = useTranslation('settings')
  const text = useDeviceActionGroupText()
  const { state, reload } = useThisDeviceState()
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [saveFailure, setSaveFailure] = useState<string | null>(null)
  const save = (...args: Parameters<typeof saveDevicePermission>) => updateDevicePermission(args, reload, setSaveFailure)

  const header = bare ? null : (
    <PageHeader
      title={t('devices.deviceActions.thisTitle')} panelNavigation={panelNavigation} navigationKey="device:this-computer"
      backLabel={t('devices.deviceActions.back')}
      onBack={onBack}
    />
  )
  const permissionLink = <SettingsGroup><SettingsRow title={t('devices.deviceActions.managePermissions')} control={<ChevronRight size={16} />} data-testid="device-open-permissions"
    onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'permissions' } }))} /></SettingsGroup>
  if (!state) return <SettingsPage data-testid="settings-device-actions">{header}{children}<SettingsNote>{t('devices.loading')}</SettingsNote>{!managePermissions && permissionLink}</SettingsPage>
  if (!state.supported) return <SettingsPage data-testid="settings-device-actions">{header}{children}<SettingsNote>{t('devices.deviceActions.unsupported')}</SettingsNote>{!managePermissions && permissionLink}</SettingsPage>

  const connected = state.groups.filter((g) => g.connected)
  if (!managePermissions) return (
    <SettingsPage data-testid="settings-device-actions">
      {header}
      {children}
      <SettingsNote>{t('devices.deviceActions.thisNote')}</SettingsNote>
      {state.denyAll && <SettingsNote>{t('devices.deviceActions.denyAllOn')}</SettingsNote>}
      {connected.length ? <SettingsGroup title={t('devices.deviceActions.connected')}>
        {connected.map(group => <SettingsRow key={group.id} leading={<GroupIcon group={group} size="row" />} title={text.name(group.id)}
          data-testid={`device-granted-${group.id}`} control={group.blocked ? <Chip tone="warn">{t(group.blocked.reason === 'os_permission' ? 'devices.deviceActions.statusBlocked' : 'devices.deviceActions.statusUnsupported')}</Chip> : undefined} />)}
      </SettingsGroup> : <SettingsNote>{t('devices.assistantPage.noneGranted')}</SettingsNote>}
      {permissionLink}
    </SettingsPage>
  )

  const selected = openGroup ? state.groups.find((g) => g.id === openGroup) ?? null : null
  if (selected) return <GroupDetail settingsNavigation={bare} panelNavigation={panelNavigation} group={selected} denyAll={state.denyAll} onBack={() => setOpenGroup(null)} reload={reload} backLabel={backLabel} />

  const available = state.groups.filter((g) => !g.connected && !g.blocked)
  const systemBlocked = state.groups.filter((g) => !g.connected && g.blocked?.reason === 'os_permission')
  const unsupported = state.groups.filter((g) => !g.connected && g.blocked && g.blocked.reason !== 'os_permission')
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
      control={<><span className="gg-settings-row-value">{t(group.blocked ? group.blocked.reason === 'os_permission' ? 'devices.deviceActions.statusBlocked' : 'devices.deviceActions.statusUnsupported' : group.connected ? 'devices.deviceActions.statusConnected' : 'devices.deviceActions.statusNotConnected')}</span><ChevronRight size={16} /></>}
      onClick={() => setOpenGroup(group.id)}
    />
  )

  return (
    <SettingsPage data-testid="settings-device-actions">
      {header}
      {children}
      {saveFailure && <SettingsNote role="alert" tone="danger">{t('devices.deviceActions.connectFailed', { message: saveFailure })}</SettingsNote>}
      {state.denyAll && <SettingsNote tone="danger" data-testid="settings-device-actions-deny-all-on">{t('devices.deviceActions.denyAllOn')}</SettingsNote>}
      {connected.length > 0 && <SettingsGroup title={t('devices.deviceActions.connected')} data-testid="settings-device-actions-connected">{connected.map(row)}</SettingsGroup>}
      {available.length > 0 && <SettingsGroup title={t('devices.deviceActions.statusNotConnected')} data-testid="settings-device-actions-available">{available.map(row)}</SettingsGroup>}
      {systemBlocked.length > 0 && <SettingsGroup title={t('devices.deviceActions.statusBlocked')} data-testid="settings-device-actions-system-blocked">{systemBlocked.map(row)}</SettingsGroup>}
      {unsupported.length > 0 && <SettingsGroup title={t('devices.deviceActions.statusUnsupported')} data-testid="settings-device-actions-unsupported">{unsupported.map(row)}</SettingsGroup>}
      <SettingsGroup>
        <SettingsRow
          title={t('devices.deviceActions.denyAll')}
          description={t('devices.deviceActions.denyAllHint')}
          control={(
            <Toggle
              checked={state.denyAll}
              ariaLabel={t('devices.deviceActions.denyAll')}
              onChange={(on) => { void save(DEVICE_ACTIONS_CHANNELS.setDenyAll, on, { action: 'deny-all', enabled: on }) }}
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

function GroupDetail({ group, denyAll, onBack, reload, backLabel, panelNavigation = false, settingsNavigation = false }: { settingsNavigation?: boolean; panelNavigation?: boolean; group: DeviceActionsGroupView; denyAll: boolean; onBack: () => void; reload: () => void; backLabel?: string }) {
  const { t, i18n } = useTranslation('settings')
  const text = useDeviceActionGroupText()
  const english = i18n.language.startsWith('en')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ message: string; settingsUrl?: string; restart?: true } | null>(null)
  const name = text.name(group.id)
  const settingsDetail = useSettingsDetail(settingsNavigation ? `permission:${group.id}` : null, name, onBack)
  const save = (...args: Parameters<typeof saveDevicePermission>) => updateDevicePermission(args, reload, message => setFailure(message ? { message } : null))

  const connect = useCallback(async () => {
    const ipc = desktopIpc()
    if (!ipc) return
    const ownerId = cachedDevicesAccount()
    setBusy(true)
    setFailure(null)
    try {
      const result = (await ipc.invoke(DEVICE_ACTIONS_CHANNELS.connect, group.id)) as DeviceActionsConnectResult
      if (!result.ok) setFailure({ message: result.message, ...(result.settingsUrl ? { settingsUrl: result.settingsUrl } : {}), ...(result.restart ? { restart: true } : {}) })
      else {
        const deviceId = libraryDeviceId(null)
        await reportAssistantAppChange(null, undefined, { resource: 'devices', operation: 'edited', section: 'permissions',
          id: deviceId ?? 'permission-settings', deviceId, after: { group: group.id, enabled: true } }, ownerId)
      }
    } catch (error) {
      setFailure({ message: messageForUser(error) })
    } finally {
      setBusy(false)
      reload()
    }
  }, [group.id, reload])

  const disconnect = () => save(DEVICE_ACTIONS_CHANNELS.disconnect, group.id, { action: 'disconnect', group: group.id, enabled: false })

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
        title={settingsDetail ? null : name} panelNavigation={panelNavigation} navigationKey={`device-group:${group.id}`}
        backLabel={backLabel ?? t('devices.deviceActions.thisTitle')}
        onBack={settingsDetail ? undefined : onBack}
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
          <div className="mt-1 flex flex-col items-center gap-1 text-[var(--danger-fg,#d63838)]" data-testid="settings-device-action-connect-failed" role="alert">
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
          footer={overrides > 0
            ? (
                <Button variant="ghost" size="sm" onClick={() => { void save(DEVICE_ACTIONS_CHANNELS.resetOverrides, undefined, { action: 'reset-overrides' }) }} data-testid="settings-device-action-reset-overrides">
                  {t('devices.deviceActions.resetOverrides')}
                </Button>
              )
            : undefined}
          data-testid={`settings-device-action-tools-${group.id}`}
        >
          {group.actions.map((action) => (
            <ActionRow key={action.name} action={action} english={english} disabled={!group.connected || denyAll} save={save} />
          ))}
        </SettingsGroup>
      )}
    </SettingsPage>
  )
}

function ActionRow({ action, english, disabled, save }: { action: DeviceActionsActionView; english: boolean; disabled: boolean; save: (...args: Parameters<typeof saveDevicePermission>) => Promise<void> }) {
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
            onChange={(enabled) => { void save(DEVICE_ACTIONS_CHANNELS.setActionEnabled, { action: action.name, enabled }, { action: action.name, enabled }) }}
          />
        </span>
      )}
    />
  )
}

function OtherDeviceActions({ device, compact = false }: { device: Device; compact?: boolean }) {
  const { t } = useTranslation('settings')
  const text = useDeviceActionGroupText()
  const actions = device.capabilities?.actions?.actions ?? null
  const groups = useMemo(() => {
    const out = new Map<string, DeviceActionSummary[]>()
    for (const a of actions ?? []) out.set(a.group, [...(out.get(a.group) ?? []), a])
    return [...out.entries()]
  }, [actions])
  if (isPhoneDevice(device)) return <SettingsGroup><SettingsRow title={t('devices.kind.phone')} description={t('devices.phoneActions.localAgentOnly')} control={<Chip>{t(device.is_online ? 'devices.online' : 'devices.offline')}</Chip>} /></SettingsGroup>
  if (!actions) return <SettingsNote>{t('devices.deviceActions.otherNone')}</SettingsNote>
  return (
    <>
      {!compact && <SettingsNote>{t('devices.deviceActions.otherNote')}</SettingsNote>}
      {!device.is_online && <SettingsNote tone="danger">{t('devices.deviceActions.otherOffline')}</SettingsNote>}
      <SettingsGroup>
        {groups.map(([group, list]) => {
          const on = list.some((a) => a.available)
          const reason = list.find((a) => !a.available)?.unavailable_reason
          return (
            <SettingsRow
              key={group}
              data-testid={`settings-device-action-other-${group}`}
              leading={<GroupIcon group={{ id: group }} size="row" />}
              title={text.name(group)}
              description={compact ? undefined : list.map((a) => a.title).join(' · ')}
              control={!device.is_online
                ? <Chip>{t('devices.offline')}</Chip>
                : on
                ? <Chip tone="ok">{t('devices.deviceActions.availableNow')}</Chip>
                : <Chip>{t(`devices.deviceActions.unavailable.${reason ?? 'not_granted'}`)}</Chip>}
            />
          )
        })}
      </SettingsGroup>
    </>
  )
}
