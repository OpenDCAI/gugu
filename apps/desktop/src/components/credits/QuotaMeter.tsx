import type { QuotaWindowView } from '../../lib/billing'
import { formatCredits, quotaWindowLabel } from '../../lib/billing'
import { useTranslation } from 'react-i18next'

// 一个额度窗口的刻度:一根条。侧栏那圈环随「左栏只放 App」(#7046)拿掉了,积分只在用量页。
//
// 刻度上有两段:已结算的用量(实色)和已发出未结算的预留(同色低透明度)。预留必须看得见,否则
// 用户会觉得「明明没花那么多,怎么开不了新会话」。
//
// 窗口名(「5 小时」「7 天」)由服务端给的时长算出,不写死 —— 运营改窗口长度时文案自动跟着改。

// 走 token 而非字面时长:交互时序统一归 tokens.css 管,CI 的 UI-state 债务闸也只认 token。
const FILL_TRANSITION = 'width var(--dur-med) var(--ease)'

const trackStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  borderRadius: 'var(--radius-capsule)',
  background: 'var(--muted)',
  overflow: 'hidden',
}

export function QuotaMeter({
  window: view,
  testId,
}: {
  window: QuotaWindowView
  testId?: string
}) {
  const { t } = useTranslation('settings')
  const label = quotaWindowLabel(view.hours)
  // 用尽时把刻度染成警示色 —— 唯一一处用非中性色,克制地只在真的用尽时出现。
  const exhausted = view.remaining <= 0
  const fill = exhausted ? 'var(--danger)' : 'var(--primary)'
  const meter = {
    'data-testid': testId,
    role: 'meter',
    'aria-label': t('credits.meterLabel', { window: label }),
    'aria-valuenow': view.used,
    'aria-valuemin': 0,
    'aria-valuemax': view.limit,
    'aria-valuetext': t('credits.meterValue', {
      window: label,
      used: formatCredits(view.used),
      limit: formatCredits(view.limit),
    }),
  }

  return (
    <div {...meter} style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 'var(--font-body)', color: 'var(--fg)' }}>{label}</span>
        <span style={{ fontSize: 'var(--font-caption)', color: 'var(--muted-fg)', fontVariantNumeric: 'tabular-nums' }}>
          {formatCredits(view.used)} / {formatCredits(view.limit)}
        </span>
      </div>
      <span style={{ ...trackStyle, height: 6 }}>
        <span style={{ display: 'flex', height: '100%', width: '100%' }}>
          <span style={{ width: `${view.usedRatio * 100}%`, background: fill, transition: FILL_TRANSITION }} />
          {view.heldRatio > 0 && (
            <span
              title={t('credits.heldTitle')}
              style={{ width: `${view.heldRatio * 100}%`, background: fill, opacity: 0.35, transition: FILL_TRANSITION }}
            />
          )}
        </span>
      </span>
    </div>
  )
}
