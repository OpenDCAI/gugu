import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentSettingsPaneProps } from './types'
import { asClass, financePillClass } from './agentSettingsStyles'

// TODO(finance backend): wire to real billing backend when available.
// The design shows time-range pills + 4 stat cards (已结算收入/待结算/运行成本/净额).
// All monetary values are placeholder zeros per the design's own empty state.

type TimePill = 'today' | 'yesterday' | 'sevenDays' | 'custom'

export function AgentFinancePane({ agent: _agent }: AgentSettingsPaneProps) {
  const { t } = useTranslation('agents')
  const [activePill, setActivePill] = useState<TimePill>('sevenDays')

  const pills: TimePill[] = ['today', 'yesterday', 'sevenDays', 'custom']

  return (
    <div>
      {/* 账务 — design data-pane="finance" */}
      <div className={asClass.financeTitle}>{t('settings.finance.title')}</div>

      {/* #1228: finance 后端未建 → 时间 pills 诚实禁用「即将开放」(原先切换不改数据=假交互)；
          统计值一律诚实空态「—」(原先写死 ¥ 假数据)。后端落地后接真结算数据 + range 过滤。 */}
      <div className={asClass.financePills}>
        {pills.map((pill) => (
          <button
            key={pill}
            className={financePillClass(activePill === pill)}
            onClick={() => setActivePill(pill)}
            disabled
            aria-disabled
            title={t('common.comingSoon')}
            style={{ opacity: 0.45, cursor: 'not-allowed' }}
          >
            {t(`settings.finance.${pill}`)}
          </button>
        ))}
      </div>

      <div className={asClass.financeH2}>{t('settings.finance.overview')}</div>

      <div className={asClass.financeGrid}>
        {/* TODO(finance backend): replace ¥0.00 with real settled income for selected range */}
        <div className={asClass.financeCard}>
          <div className={asClass.financeCardLabel}>{t('settings.finance.settled')}</div>
          <div className={asClass.financeCardValue}>—</div>
          <div className={asClass.financeCardDesc}>{t('settings.finance.settledHint')}</div>
        </div>

        {/* TODO(finance backend): replace ¥0.00 with real pending settlement amount */}
        <div className={asClass.financeCard}>
          <div className={asClass.financeCardLabel}>{t('settings.finance.pending')}</div>
          <div className={asClass.financeCardValue}>—</div>
          <div className={asClass.financeCardDesc}>{t('settings.finance.pendingHint')}</div>
        </div>

        {/* TODO(finance backend): replace ¥0.03 with real LLM + sandbox cost for selected range */}
        <div className={asClass.financeCard}>
          <div className={asClass.financeCardLabel}>{t('settings.finance.cost')}</div>
          <div className={asClass.financeCardValue}>—</div>
          <div className={asClass.financeCardDesc}>{t('settings.finance.costHint')}</div>
        </div>

        {/* TODO(finance backend): replace −¥0.03 with real net (settled income − run cost) */}
        <div className={asClass.financeCard}>
          <div className={asClass.financeCardLabel}>{t('settings.finance.net')}</div>
          <div className={asClass.financeCardValue}>—</div>
          <div className={asClass.financeCardDesc}>{t('settings.finance.netHint')}</div>
        </div>
      </div>
    </div>
  )
}
