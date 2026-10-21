import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { platform } from '../../platform'
import type { SystemPermission, SystemPermissionState } from '../../platform/types'
import {
  SYSTEM_PERMISSION_ROWS,
  systemPermissionAction,
  systemPermissionRows,
  useSystemPermissionStates,
} from '../../lib/systemPermissions'
import { ChevronRight } from '@/lib/icons'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'

/**
 * 「我的 → 权限」(product spec)。
 *
 * 一行 = 一项系统权限:标题 + 系统当下的真实状态 + 一句「用来……」,整行可点。
 * 状态每次进来、每次回到前台都重新问系统(useSystemPermissionStates);点下去能弹框就弹,
 * 不能就直达系统里咕咕的对应设置页,连设置页都跳不过去就说清去哪改 —— ❌ 点了没反应。
 * 桌面与手机是同一页;列哪几行由 `platform.systemPermissions` 决定,一行都没有时整页连导航项都不出现。
 */

const STATE_KEYS: Record<SystemPermissionState, string> = {
  granted: 'settings.permissions.on',
  prompt: 'settings.permissions.offPrompt',
  blocked: 'settings.permissions.offBlocked',
  unreadable: 'settings.permissions.unknown',
}

function labelKeyOf(permission: SystemPermission): string {
  const row = SYSTEM_PERMISSION_ROWS.find((candidate) => candidate.permission === permission)
  if (!row) throw new Error(`no permissions row for ${permission}`)
  return row.labelKey
}

export function PermissionsSection() {
  const { t } = useTranslation('main')
  const rows = systemPermissionRows()
  const { states, refresh, failed } = useSystemPermissionStates(rows.map((row) => row.permission))
  const [pending, setPending] = useState<SystemPermission | null>(null)
  const [unreachable, setUnreachable] = useState<SystemPermission | null>(null)

  const act = async (permission: SystemPermission, state: SystemPermissionState) => {
    setPending(permission)
    setUnreachable(null)
    try {
      if (systemPermissionAction(state) === 'request') {
        await platform.requestSystemPermission(permission)
      } else if (!(await platform.openSystemPermissionSettings(permission))) {
        setUnreachable(permission)
      }
    } catch {
      // 弹框或跳转本身失败(个别厂商没有那一页):下一步只剩用户自己去系统设置,照实指路。
      setUnreachable(permission)
    } finally {
      setPending(null)
      await refresh()
    }
  }

  return (
    <SettingsPage data-testid="settings-permissions">
      <SettingsNote>{t('settings.permissions.intro')}</SettingsNote>
      <SettingsGroup
        footer={(
          <>
            {unreachable !== null && (
              <SettingsNote role="status">
                {t('settings.permissions.settingsUnreachable', { name: t(labelKeyOf(unreachable)) })}
              </SettingsNote>
            )}
            {failed && <SettingsNote role="alert">{t('settings.permissions.readFailed')}</SettingsNote>}
          </>
        )}
      >
        {rows.map((row) => {
          const state = states[row.permission]
          return (
            <SettingsRow
              key={row.permission}
              aria-disabled={state === undefined || pending !== null}
              data-testid={`settings-permission-${row.permission}`}
              data-permission-state={state}
              title={t(row.labelKey)}
              description={t(row.purposeKey)}
              // 与「我的」入口列表同一种行尾:状态 + ›,整行可点。
              control={(
                <>
                  {state !== undefined && <span className="gg-settings-row-value">{t(STATE_KEYS[state])}</span>}
                  <ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" />
                </>
              )}
              onClick={() => {
                if (state === undefined || pending !== null) return
                void act(row.permission, state)
              }}
            />
          )
        })}
      </SettingsGroup>
    </SettingsPage>
  )
}
