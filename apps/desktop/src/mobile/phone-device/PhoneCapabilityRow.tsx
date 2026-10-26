import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { PaneHeader } from '@/components/ui/Pane'
import { Sheet } from '@/components/ui/Sheet'
import { SettingsRow } from '@/components/settings/SettingsPrimitives'
import { Bell, CalendarClock, ChevronRight, Clock, Compass, Heart, Image, MessageSquare, Mic, Users, X } from '@/lib/icons'
import { missingRequirements, requirementGranted, type PhoneActionGroup, type PhoneOsState, type PhoneRequirement } from './phoneActionCatalog'
import { HEALTH_TYPES, type PhoneSettingsTarget } from './nativePhoneActions'
import { PhoneSheetHandle } from '../PhoneSheetHandle'

export type PhoneCapabilityReadState = 'loading' | 'ready' | 'failed'
export type PhoneCapabilityAction =
  | { kind: 'connect' }
  | { kind: 'disconnect' }
  | { kind: 'grant'; requirement: PhoneRequirement }
  | { kind: 'settings'; target: PhoneSettingsTarget; name: string }

const GROUP_ICONS = { calendar: CalendarClock, contacts: Users, location: Compass, notifications: Bell, alarm: Clock, health: Heart, sms: MessageSquare, recordings: Mic, photos: Image }
const SETUP_PURPOSES: Record<PhoneActionGroup, string> = {
  calendar: '查询、新建和修改日程', contacts: '查找联系人', location: '获取当前位置',
  notifications: '读取通知、管理勿扰', alarm: '设置闹钟和倒计时', health: '读取睡眠、步数等健康数据',
  sms: '读取短信', recordings: '读取已有录音和共享音频', photos: '读取你授权的照片与视频',
}

export function PhoneCapabilityRow({ group, connected, os, readState, busy, error, testPrefix, onAction, onRetry, presentation = 'sheet' }: {
  group: PhoneActionGroup
  presentation?: 'sheet' | 'inline' | 'summary'
  connected: boolean
  os: PhoneOsState | null
  readState: PhoneCapabilityReadState
  busy: PhoneActionGroup | null
  error: string | null
  testPrefix: string
  onAction: (action: PhoneCapabilityAction) => void
  onRetry: () => void
}) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const title = t(`devices.deviceActions.group.${group}`)
  const Icon = GROUP_ICONS[group]
  const missing = missingRequirements(group, os)
  const noClock = group === 'alarm' && !!os && !os.special.alarm_app
  const noHealth = group === 'health' && !!os && !os.health.supported
  const noData = ['sms', 'recordings', 'photos'].includes(group) && !!os && !os.data?.supported
  const unsupported = noClock || noHealth || noData
  const readable = readState === 'ready' && os !== null
  const disabled = busy !== null || !readable
  const locationGranted = group === 'location' && !!os && requirementGranted('location', os)
  const locationOff = locationGranted && !os?.special.location_enabled
  const healthGranted = os?.health.granted_types.length ?? 0
  const healthBackgroundMissing = group === 'health' && os?.health.background_supported && !os.health.background_granted
  const status = readState === 'failed' ? '读取系统权限失败'
    : !readable ? '正在读取系统状态'
      : unsupported ? t('devices.deviceActions.statusUnsupported')
        : !connected ? t('devices.deviceActions.statusNotConnected')
          : missing.length > 0 ? '已选择，尚缺系统授权'
            : locationOff ? '已选择，定位服务未开启' : t('devices.deviceActions.statusConnected')
  const tone = readable && connected && !unsupported ? missing.length > 0 || locationOff ? 'warn' : 'live' : undefined
  const openSettings = (target: PhoneSettingsTarget, name: string) => onAction({ kind: 'settings', target, name })
  const detailsId = `${testPrefix}-details-${group}`
  const connect = () => { if (presentation === 'inline') setOpen(true); onAction({ kind: 'connect' }) }
  if (presentation === 'summary') return (
    <div className="gg-phone-setup-field" data-testid={`${testPrefix}-group-${group}`}>
      <div className="gg-phone-setup-field-main">
        <span className="gg-phone-setup-field-title">{title}</span>
        <span className="gg-phone-capability-status" data-tone={tone} role="status">{status}</span>
      </div>
    </div>
  )
  const connection = connected ? (
    <Button size="sm" variant="ghost" disabled={busy !== null} aria-label={`${title}，断开连接`} data-testid={`${testPrefix}-disconnect-${group}`} onClick={() => onAction({ kind: 'disconnect' })}>
      {t('devices.deviceActions.disconnect')}
    </Button>
  ) : (
    <Button size="sm" variant={presentation === 'inline' ? 'secondary' : 'primary'} disabled={disabled || unsupported} aria-label={`${title}，连接`} data-testid={`${testPrefix}-connect-${group}`} onClick={connect}>
      {busy === group ? t('devices.deviceActions.connecting') : t('devices.deviceActions.connect')}
    </Button>
  )

  const content = (<>
    <p className="gg-phone-capability-purpose">{t(`devices.phoneActions.groupDescription.${group}`)}</p>
    {presentation === 'sheet' && <div className="gg-phone-capability-status" data-tone={tone} role="status">{status}</div>}
    {presentation === 'sheet' && connection}
    {readState === 'failed' && <Button variant="ghost" onClick={onRetry}>重新读取权限</Button>}
    <div className="gg-phone-capability-content">
      {readable && (
        <>
          {group === 'notifications' && <div className="gg-phone-notification-scope">
            <p>通知读取 · {os.special.notification_listener ? '已授权' : '未授权'}<span>让 Agent 读取其他 App 的通知。</span></p>
            <p>勿扰控制 · {os.special.dnd_access ? '已授权' : '未授权'}<span>让 Agent 按你的指令调整勿扰模式。</span></p>
            <p className="gg-phone-capability-notice">{presentation === 'inline' ? '咕咕自己的消息提醒在上方「系统权限」中设置，这里不会开启它。' : '咕咕自己的消息提醒在「消息与后台」中设置，这里不会开启它。'}</p>
          </div>}
          {unsupported && <div className="gg-phone-capability-notice" data-testid={noHealth ? `${testPrefix}-health-unsupported` : undefined}>
            {t(noClock ? 'devices.phoneActions.noClockApp' : noData ? 'devices.phoneActions.dataOldApp' : os.health.old_app ? 'devices.phoneActions.healthOldApp' : 'devices.phoneActions.healthUnsupported')}
          </div>}
          {connected && missing.length > 0 && (
            <div className="gg-phone-capability-actions" data-testid={`${testPrefix}-missing-${group}`}>
              {missing.map((requirement) => (
                <Button key={requirement} variant="secondary" size="sm" disabled={disabled} data-testid={`${testPrefix}-grant-${requirement}`} onClick={() => onAction({ kind: 'grant', requirement })}>
                  {t('devices.phoneActions.grant')} · {t(`devices.phoneActions.requirements.${requirement}`)}
                </Button>
              ))}
            </div>
          )}
          {connected && group === 'notifications' && missing.length > 0 && <div className="gg-phone-capability-notice">{t('devices.phoneActions.restrictedHint')}</div>}
          {group === 'health' && os.health.supported && !os.health.background_supported && <div className="gg-phone-capability-notice" data-testid={`${testPrefix}-health-foreground-only`}>{t('devices.phoneActions.healthForegroundOnly')}</div>}
          {connected && group === 'health' && os.health.supported && (healthGranted > 0 || healthBackgroundMissing) && (
            <div className="gg-phone-capability-notice" data-testid={`${testPrefix}-health-granted`}>
              {healthGranted > 0 && <div>{t('devices.phoneActions.healthPartial', { granted: healthGranted, total: HEALTH_TYPES.length })}</div>}
              {healthBackgroundMissing && <div>{t('devices.phoneActions.healthBackgroundHint')}</div>}
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => openSettings('health', t('devices.phoneActions.requirements.health_connect'))}>{t('devices.phoneActions.healthManage')}</Button>
            </div>
          )}
          {connected && locationOff && (
            <div className="gg-phone-capability-notice">
              <div>{t('devices.phoneActions.locationServicesOff')}</div>
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => openSettings('location', t('devices.deviceActions.group.location'))}>{t('devices.phoneActions.openLocationSettings')}</Button>
            </div>
          )}
          {connected && locationGranted && !os.special.background_location && (
            <div className="gg-phone-capability-notice" data-testid={`${testPrefix}-background-location`}>
              <div>{t('devices.phoneActions.backgroundLocationHint')}</div>
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => openSettings('app', t('devices.phoneActions.requirements.location'))}>{t('devices.phoneActions.openAppSettings')}</Button>
            </div>
          )}
          {connected && group === 'photos' && os.data?.supported && (
            <div className="gg-phone-capability-notice">
              {os.data.selected && !os.data.images && !os.data.videos && <div>{t('devices.phoneActions.photosSelected')}</div>}
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => os.data?.images || os.data?.videos ? openSettings('app', t('devices.phoneActions.requirements.photos')) : onAction({ kind: 'grant', requirement: 'photos' })}>{t('devices.phoneActions.photosManage')}</Button>
            </div>
          )}
        </>
      )}
      {error && <div className="gg-phone-capability-error" role="alert">{error}</div>}
    </div>
  </>)
  if (presentation === 'inline') return (
    <div className="gg-phone-setup-field" data-testid={`${testPrefix}-group-${group}`} data-connected={connected}>
      <div className="gg-phone-setup-field-main">
        <Button variant="ghost" className="gg-phone-setup-field-copy gg-phone-setup-disclosure" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
          <span className="gg-phone-setup-field-title">{title}<ChevronRight className="size-4" aria-hidden="true" /></span>
          <span className="gg-phone-setup-field-purpose">{SETUP_PURPOSES[group]}</span>
          {(connected || !readable || unsupported) && <span className="gg-phone-capability-status" data-tone={tone} role="status">{status}</span>}
        </Button>
        {connection}
      </div>
      {open && <div id={detailsId} className="gg-phone-setup-field-details" data-testid={`${testPrefix}-capability-${group}`}>{content}</div>}
    </div>
  )

  return (
    <div className="gg-phone-capability-item" data-testid={`${testPrefix}-group-${group}`} data-connected={connected}>
      <SettingsRow
        className="gg-phone-capability-row"
        leading={<Icon className="size-5 gg-phone-setting-icon" aria-hidden="true" />}
        title={title}
        description={<span className="gg-phone-capability-status" data-tone={tone} role="status">{status}</span>}
        control={<ChevronRight className="size-4 gg-phone-setting-icon" aria-hidden="true" />}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`${title}，${status}，设置`}
      />
      {open && <Sheet onClose={() => setOpen(false)} mobileFitContent ariaLabel={title} testId={`${testPrefix}-capability-${group}`}>
        <div className="gg-phone-capability-sheet">
          <PhoneSheetHandle onDismiss={() => setOpen(false)} />
          <PaneHeader mobile title={title} titleLevel="page" actions={<IconButton size="md" aria-label={`关闭${title}设置`} onClick={() => setOpen(false)}><X /></IconButton>} />
          <div className="gg-phone-capability-sheet-body">{content}
          </div>
        </div>
      </Sheet>}
    </div>
  )
}
