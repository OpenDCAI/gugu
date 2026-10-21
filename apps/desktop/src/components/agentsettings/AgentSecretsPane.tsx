import type { AgentSettingsPaneProps } from './types'
import { Trans, useTranslation } from 'react-i18next'
import { agentSettingsPaneClass, asClass } from './agentSettingsStyles'

// TODO(agent env-var secrets backend): no backend exists for agent env-var secret injection.
// The design shows a "secret call NAME" mechanism (env-var injection into child processes).
// The removed apikey system (#934) is NOT related — do NOT wire to it.
// When the backend lands, replace the empty state with real data here.

export function AgentSecretsPane({ agent: _agent }: AgentSettingsPaneProps) {
  const { t } = useTranslation('agents')
  // #1228: agent env-var secrets 后端未建 → 「添加」按钮诚实禁用「即将开放」(反 fake，
  // 同 QuotaSection 占位法)；空态本就诚实。后端落地后接真「添加」对话 + secret 列表。
  return (
    <div className={agentSettingsPaneClass(true)} data-pane="secrets">
      {/* sk-head: title row + add button */}
      <div className={asClass.secretsHead}>
        <div className={asClass.secretsH2}>{t('settings.secrets.title')}</div>
        <button
          className={asClass.secretsButton}
          disabled
          aria-disabled
          title={t('common.comingSoon')}
          style={{ opacity: 0.45, cursor: 'not-allowed' }}
        >
          {/* inline SVG */}
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24">
            <g fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 12c0-4.714 0-7.071 1.464-8.536C4.93 2 7.286 2 12 2s7.071 0 8.535 1.464C22 4.93 22 7.286 22 12s0 7.071-1.465 8.535C19.072 22 16.714 22 12 22s-7.071 0-8.536-1.465C2 19.072 2 16.714 2 12Z" />
              <path strokeLinecap="round" d="M15 12h-3m0 0H9m3 0V9m0 3v3" />
            </g>
          </svg>
          {t('settings.secrets.add')}
        </button>
      </div>

      {/* description card */}
      <div className={asClass.secretsArd}>
        {t('settings.secrets.description')}
      </div>

      {/* empty state */}
      {/* TODO(agent env-var secrets backend): replace with secret list when backend lands */}
      <div className={asClass.secretsEmpty}>
        {t('settings.secrets.empty')}
        <div className={asClass.secretsEmptySub}>
          <Trans
            t={t}
            i18nKey="settings.secrets.emptyHint"
            components={{ command: <code /> }}
          />
        </div>
      </div>
    </div>
  )
}
