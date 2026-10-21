import type { AgentSettingsPaneProps } from './types'
import { useTranslation } from 'react-i18next'
import { asClass, cx, permissionsSelectStyle } from './agentSettingsStyles'

// TODO(grants backend): no backend exists for agent grants yet.
// Design shows: 创建授权 form (角色 select + 到期 date + 创建授权 button)
// + 活跃授权 · 0 empty state ("暂无活跃授权").
// Wire to real grants API when it exists.

export function AgentPermissionsPane({ agent: _agent }: AgentSettingsPaneProps) {
  const { t } = useTranslation('agents')
  return (
    <div>
      {/* per design */}
      <div className={asClass.permissionsH2} style={{ marginTop: 0 }}>{t('settings.permissions.title')}</div>
      {/* line 1049 */}
      <div className={asClass.permissionsArd} style={{ marginBottom: 4 }}>
        {t('settings.permissions.description')}
      </div>
      {/* line 1050-1056: grant-card */}
      <div className={asClass.permissionsGrantCard}>
        <div className={asClass.permissionsArl} style={{ marginBottom: 9 }}>{t('settings.permissions.create')}</div>
        <div className={asClass.permissionsArd} style={{ marginBottom: 10 }}>
          {t('settings.permissions.createHint')}
        </div>
        {/* 角色 field */}
        <div className={asClass.permissionsField}>
          <div className={asClass.permissionsLabel}>{t('settings.permissions.role')}</div>
          {/* #1228: grants 后端未建 → 角色 select 诚实禁用「即将开放」(反 fake) */}
          <select
            className={cx(asClass.permissionsSelect, asClass.permissionsSelectWide)}
            style={{ ...permissionsSelectStyle, opacity: 0.45, cursor: 'not-allowed' }}
            disabled
            aria-disabled
            title={t('common.comingSoon')}
          >
            <option>{t('settings.permissions.fullAccess')}</option>
            <option>{t('settings.permissions.readOnly')}</option>
            <option>{t('settings.permissions.custom')}</option>
          </select>
          <div className={asClass.permissionsArd} style={{ marginTop: 6 }}>
            {t('settings.permissions.fullAccessHint')}
          </div>
        </div>
        {/* 到期 field */}
        <div className={asClass.permissionsField}>
          <div className={asClass.permissionsLabel}>{t('settings.permissions.expires')}</div>
          {/* verbatim design line 1054: .grant-date placeholder (full-width space U+3000 before calendar emoji) */}
          {/* i18next-instrument-ignore-next-line -- locale-neutral disabled date skeleton */}
          <div className={asClass.permissionsGrantDate}>{'mm/dd/yyyy --:-- 　🗓'}</div>
          <div className={asClass.permissionsArd} style={{ marginTop: 6 }}>
            {t('settings.permissions.neverExpires')}
          </div>
        </div>
        {/* 创建授权 button — float:none per design line 1055 */}
        {/* #1228: grants 后端未建 → 诚实禁用「即将开放」(反 fake)；后端落地后接 grants create API */}
        <button
          className={asClass.permissionsSave}
          style={{ float: 'none', opacity: 0.45, cursor: 'not-allowed' }}
          type="button"
          disabled
          aria-disabled
          title={t('common.comingSoon')}
        >
          + {t('settings.permissions.create')}
        </button>
      </div>
      {/* line 1057: 活跃授权 header */}
      <div className={asClass.permissionsH2}>
        {t('settings.permissions.active')}{' '}
        {/* i18next-instrument-ignore-next-line -- numeric count separator */}
        <span style={{ color: 'var(--faint-fg)', fontWeight: 400 }}>· 0</span>
      </div>
      {/* line 1058: empty state */}
      {/* TODO(grants backend): replace with real grant list when API exists */}
      <div className={asClass.permissionsGrantEmpty}>{t('settings.permissions.empty')}</div>
    </div>
  )
}
