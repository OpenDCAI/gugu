import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LOCALES, useLocale, type LocalePreference } from '@/i18n'
import { useTheme } from '../../store/theme'
import { Button } from '../ui/Button'
import { sendTestNotification } from '../../lib/notificationDiagnostics'
import { useSystemPermissionStates } from '../../lib/systemPermissions'
import { platform } from '../../platform'
import type { SystemPermission } from '../../platform/types'
import { setNotificationSettings, useNotificationSettings, type NotificationSettings } from '../../lib/notificationSettings'
import { setTrayBadgeEnabled, useTrayBadgeEnabled } from '../../lib/trayBadgeSetting'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow, Toggle } from './SettingsPrimitives'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@renderer/lib/query-client'
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { useTerminalEnabled } from '@renderer/features/settings/use-terminal-enabled'

const LANGUAGE_OPTIONS: readonly LocalePreference[] = ['system', ...SUPPORTED_LOCALES]

/**
 * @@@5301 通知开关按**来源**排行:一行 = 一类发给你的东西,而不是一行 = 一个抽象层级。
 *
 * 刻意**没有**单独的「系统横幅」开关:聊天这一路唯一的出口就是系统横幅,再加一个总开关,
 * 它和「聊天消息通知」就是同一件事的两个名字 —— 关掉其一另一个必然失效。
 * 那种开关正是本票要删掉的 `requests` 那类死字段,❌ 别为了和任务面板层数对齐把它造出来。
 */
const NOTIFICATION_ROWS: ReadonlyArray<{
  key: keyof NotificationSettings
  labelKey: string
  descriptionKey?: string
  ariaKey: string
}> = [
  {
    key: 'chatMessages',
    labelKey: 'settings.general.notificationsChat',
    descriptionKey: 'settings.general.notificationsChatDescription',
    ariaKey: 'settings.general.notificationsChatAria',
  },
  {
    key: 'sound',
    labelKey: 'settings.general.notificationsSound',
    ariaKey: 'settings.general.notificationsSoundAria',
  },
]

// 前三种是**系统给的**结论(见 lib/notificationDiagnostics.ts)。
// ⚠️ 系统给的原因**只进日志**(主进程 notificationLogger),❌ 不拼进用户可见文案 ——
// scripts/user-copy-leak-check.mjs 的 copy-leaks-internal-detail 就是拦这个的:
// "Notifications are not allowed for this application" 对用户不可操作,他要的是下一步怎么办。
const NOTIFICATION_HINT_KEYS = {
  accepted: 'settings.general.notificationsTestSent',
  rejected: 'settings.general.notificationsTestRejected',
  unsupported: 'settings.general.notificationsTestFailed',
} as const
/**
 * 安卓 App 上的同一组提示(product spec)。桌面那组讲的是 macOS 的「提醒样式」和
 * 「左边那个按钮」,手机上既没有那个概念、也没有那个布局。
 */
const MOBILE_NOTIFICATION_HINT_KEYS: Record<keyof typeof NOTIFICATION_HINT_KEYS, string> = {
  accepted: 'settings.general.notificationsTestSentMobile',
  rejected: 'settings.general.notificationsTestRejectedMobile',
  unsupported: 'settings.general.notificationsTestFailed',
}
const NOTIFICATION_PERMISSION: readonly SystemPermission[] = ['notifications']

/**
 * 通用:语言 + 主题 + 通知 (+ 托盘角标)。通知是这一页的一个分组,不是顶层导航项。
 * @@@sidebar-tint 侧栏渐进底色**不在这一页** —— 2026-09-18 owner 把它归到会话页的设置里
 * (设置合一后是会话页画的「界面」那一格,features/settings/components/SidebarTintRow.tsx),真值仍是 lib/sidebarTint.ts。
 */
export function GeneralSection({ onOpenPermissions }: { onOpenPermissions: () => void }) {
  const { t } = useTranslation('main')
  const { preference: themePreference, setTheme } = useTheme()
  const { preference, setPreference } = useLocale()
  const notificationSettings = useNotificationSettings()
  // product spec:手机上「通用 → 通知」同时如实显示系统权限;读不到真值的宿主上恒为空、不渲染。
  const {
    states: systemNotificationStates,
    refresh: refreshSystemNotificationState,
  } = useSystemPermissionStates(NOTIFICATION_PERMISSION)
  const trayBadgeEnabled = useTrayBadgeEnabled()
  const [notificationHint, setNotificationHint] = useState<keyof typeof NOTIFICATION_HINT_KEYS | null>(null)
  const notificationBlocked = systemNotificationStates.notifications === 'prompt'
    || systemNotificationStates.notifications === 'blocked'

  return (
    <SettingsPage>
      <SettingsGroup>
        <SettingsRow
          title={<label htmlFor="settings-language">{t('settings.general.language')}</label>}
          control={(
            <select
              id="settings-language"
              className="gg-settings-select"
              value={preference}
              onChange={(event) => setPreference(event.target.value as LocalePreference)}
            >
              {LANGUAGE_OPTIONS.map((locale) => (
                <option key={locale} value={locale}>
                  {t(`settings.general.languageOptions.${locale}`)}
                </option>
              ))}
            </select>
          )}
        />
        {/* 主题开关放在通用页。四种偏好(浅/深/跟随系统/素白)——选中态画的是**偏好**不是真值,
            「跟随系统」在系统当下为浅色时解析出来也是 light,照真值画会把高亮落在「浅色」上。
            单选、每次只有一个选中 → Button variant="option"(#2987:IconButton 强制正方形,装不下两个汉字)。 */}
        <SettingsRow
          title={t('settings.general.theme')}
          control={(
            <div role="radiogroup" aria-label={t('settings.general.theme')} className="flex gap-[var(--spacing-xs)]">
              {(['light', 'dark', 'system', 'plain-white'] as const).map((themeOption) => (
                <Button
                  key={themeOption}
                  variant="option"
                  size="sm"
                  role="radio"
                  aria-checked={themePreference === themeOption}
                  onClick={() => setTheme(themeOption)}
                >
                  {t(`settings.general.${themeOption}`)}
                </Button>
              ))}
            </div>
          )}
        />
      </SettingsGroup>

      {/* @@@5301 通知。这一节**只管咕咕主界面这条链**(聊天新消息 + IM 侧 agent 会话的运行事件);
          会话页 agent 的通知是另一条独立的链、归任务设置面板。两个面板是既定结构,❌ 不要合并。 */}
      <SettingsGroup
        title={t('settings.general.notifications')}
        note={t('settings.general.notificationsScope')}
        footer={notificationHint !== null ? (
          <SettingsNote role="status">
            {t((platform.kind === 'capacitor' ? MOBILE_NOTIFICATION_HINT_KEYS : NOTIFICATION_HINT_KEYS)[notificationHint])}
          </SettingsNote>
        ) : undefined}
      >
        {/* 系统权限的**状态与开关入口只在「权限」页**(product spec)。owner 2026-09-15:
            「手机端通用这有通知,怎么权限这还有通知,这是我困糊的点」—— 同一个事实只显示一处。
            只有系统确实拦着时才出这一行指路;读不到系统状态的宿主上不出现 —— 不知道就不说。 */}
        {notificationBlocked && (
          <SettingsRow
            data-testid="settings-notifications-blocked"
            stack
            description={t('settings.general.notificationsBlocked')}
            control={(
              <Button variant="secondary" size="sm" onClick={onOpenPermissions}>
                {t('settings.general.notificationsBlockedAction')}
              </Button>
            )}
          />
        )}
        {NOTIFICATION_ROWS.map((row) => (
          <SettingsRow
            key={row.key}
            title={t(row.labelKey)}
            description={row.descriptionKey ? t(row.descriptionKey) : undefined}
            control={(
              <Toggle
                checked={notificationSettings[row.key]}
                onChange={(on) => setNotificationSettings({ [row.key]: on })}
                ariaLabel={t(row.ariaKey)}
              />
            )}
          />
        ))}
        {/* @@@5301 自验出口。开关只表达「用户想不想收」,能不能真的弹出来由系统权限说了算。
            Electron 读不到 macOS 的通知授权状态,所以给一个能自己动手验的出口:点一下,看横幅出不出来 ——
            出来了 = 整条链通;没出来 = 卡在系统设置那一层,而不是这几个开关。 */}
        <SettingsRow
          stack
          title={t('settings.general.notificationsTest')}
          control={(
            <Button
              variant="secondary"
              size="sm"
              aria-label={t('settings.general.notificationsTestAria')}
              onClick={() => {
                void sendTestNotification().then((result) => {
                  setNotificationHint(result.kind)
                  void refreshSystemNotificationState()
                })
              }}
            >
              {t('settings.general.notificationsTestAction')}
            </Button>
          )}
        />
      </SettingsGroup>

      {/* 终端开关:默认关,普通用户不需要知道终端是什么。开着 = 终端的入口与界面全部回来、新任务走编程;
          它取代了原来的「通用 / 编程」手动切换。只管人看不看得到,❌ 管 agent 自己跑 pty。
          手机上没有本机的会话运行时,不出现。壳的设置页不在会话页的 QueryClientProvider 里:套同一个 queryClient,
          与会话页读的是同一份缓存,拨了那边立刻跟着变。 */}
      {platform.capabilities.agentRuntime ? (
        <QueryClientProvider client={queryClient}><TerminalGroup /></QueryClientProvider>
      ) : null}

      {/* @@@5295 托盘角标。它数的是**未读聊天消息**(#6433),但它是窗口外观不是通知,所以自成一组 ——
          ❌ 别并进上面的通知组:关掉角标不等于关掉通知,反过来也是。
          只在有托盘角标的宿主上出现(能力位 badge,目前只有桌面):手机上没有托盘,一个拨了也不会有任何
          变化的开关就是 fake。 */}
      {platform.capabilities.badge && (
        <SettingsGroup title={t('settings.general.trayBadge')}>
          <SettingsRow
            title={t('settings.general.trayBadgeEnabled')}
            control={(
              <Toggle
                checked={trayBadgeEnabled}
                onChange={setTrayBadgeEnabled}
                ariaLabel={t('settings.general.trayBadgeAria')}
              />
            )}
          />
        </SettingsGroup>
      )}
    </SettingsPage>
  )
}

/** 本机 `terminal.enabled` 的那一行(设置服务本地那份,❌ 跟着机器设置页选的机器走)。 */
function TerminalGroup() {
  const { t } = useTranslation('main')
  const enabled = useTerminalEnabled()
  const { update } = useAppSettingsKey('terminal')
  return (
    <SettingsGroup>
      <SettingsRow
        title={t('settings.general.terminal')}
        description={t('settings.general.terminalDescription')}
        control={(
          <Toggle
            checked={enabled}
            onChange={(next) => update({ enabled: next })}
            ariaLabel={t('settings.general.terminal')}
          />
        )}
      />
    </SettingsGroup>
  )
}
