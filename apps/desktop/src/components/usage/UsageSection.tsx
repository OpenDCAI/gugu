import { officialServicesEnabled } from '@gugu/core/cloud/optionalServices'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../store/auth'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { RANGE_PRESETS, rangeFor, totalsFor, type RangePreset } from '../../lib/usage/derive'
import type { Loadable } from './useUsageData'
import { useCreditData } from './useUsageData'
import { UsageCredits } from './UsageCredits'
import { SettingsNote } from '../settings/SettingsPrimitives'
import './usage.css'

/**
 * 设置 →「用量」(product spec):积分放在最前 —— 余额与额度 → 统计条 → 消耗分布 → 模型调用分析 → 使用日志。
 * 这里只有走咕咕模型、扣积分的那部分;会话、热力图、按引擎(含自己账号的 token)在另一页「活跃」。
 */
export function UsageSection() {
  const { t } = useTranslation('settings')
  return officialServicesEnabled() ? <ConfiguredUsageSection /> : <SettingsNote>{t('usage.notConfigured')}</SettingsNote>
}

function ConfiguredUsageSection() {
  const { t } = useTranslation('settings')
  const { user } = useAuth()
  const [preset, setPreset] = useState<RangePreset>('30d')
  const data = useCreditData(user?.id ?? null)
  const { current } = useMemo(() => rangeFor(preset, data.today), [preset, data.today])
  const guguTokens = useMemo<Loadable<number>>(() => data.usage.status === 'ready'
    ? { status: 'ready', value: totalsFor(data.usage.value, current).guguTokens }
    : data.usage, [data.usage, current])
  return (
    <div className="gg-usage" data-testid="usage-section">
      {/* @@@6436 页首说明与其它设置内页同一种(正文字号);原来是 11px caption,手机上低于正文 14px 下限。 */}
      <SettingsNote>{t('usage.usageScope')}</SettingsNote>
      <div className="gg-usage-toolbar">
        <SegmentedTabs
          ariaLabel={t('usage.range')}
          value={preset}
          onChange={setPreset}
          items={RANGE_PRESETS.map((p) => ({ value: p, label: t(`usage.ranges.${p}`), testId: `usage-range-${p}` }))}
        />
      </div>
      <UsageCredits credits={data.credits} guguTokens={guguTokens} range={current} />
    </div>
  )
}
