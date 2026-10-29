import { officialServicesEnabled } from '@gugu/core/cloud/optionalServices'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../store/auth'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { RANGE_PRESETS, rangeFor, totalsFor, type RangePreset } from '../../lib/usage/derive'
import type { Loadable } from './useUsageData'
import { useCreditData } from './useUsageData'
import { UsageCredits } from './UsageCredits'
import { ActivitySection } from './ActivitySection'
import './usage.css'

/**
 * #986:用量共用一套时间段。积分按账户算,设备筛选只属于下面的活跃区块。
 */
export function UsageSection() {
  const { t } = useTranslation('settings')
  const [preset, setPreset] = useState<RangePreset>('30d')
  return (
    <div className="gg-usage" data-testid="usage-section">
      <div className="gg-usage-toolbar">
        <SegmentedTabs
          ariaLabel={t('usage.range')}
          value={preset}
          onChange={setPreset}
          items={RANGE_PRESETS.map((p) => ({ value: p, label: t(`usage.ranges.${p}`), testId: `usage-range-${p}` }))}
        />
      </div>
      {officialServicesEnabled() && <ConfiguredCreditUsage preset={preset} />}
      <ActivitySection preset={preset} />
    </div>
  )
}

function ConfiguredCreditUsage({ preset }: { preset: RangePreset }) {
  const { user } = useAuth()
  const data = useCreditData(user?.id ?? null)
  const { current } = useMemo(() => rangeFor(preset, data.today), [preset, data.today])
  const guguTokens = useMemo<Loadable<number>>(() => data.usage.status === 'ready'
    ? { status: 'ready', value: totalsFor(data.usage.value, current).guguTokens }
    : data.usage, [data.usage, current])
  return <UsageCredits credits={data.credits} guguTokens={guguTokens} range={current} />
}
