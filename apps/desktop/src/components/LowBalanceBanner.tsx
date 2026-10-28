// @@@1548 §3 低额预警:云对话按成本扣积分,能花的会走低。在被服务端阻断(合计=0)**之前**,
//   合计落入 (0, 阈值) 就顶部横幅「积分不足,建议充值」+ 充值快捷入口 → 别等耗尽才发现。
//   ⚠️ 判据是「会员额度 + 不过期积分」的**合计**,不是不过期积分那一个池子 —— 只看后者会给
//   一个周期额度还剩 345 的 max 会员弹「积分不足(剩 0.14 积分)」,他并不缺钱、充值也没意义。
//   合计=0(已耗尽)不在此弹——耗尽由服务端在发起前调闸并回「都已用完」;本横幅是**提前**预警。
//   取不到(未登录/billing schema 未暴露 #1523/网络)→ 不弹(回落 null,**不编造**,反 fake)。
//   阈值单常量,owner 可调。回到 app(可能刚跑过云对话扣费)→ 刷新,让走低及时触发。
import { useEffect, useState } from 'react'
import { AlertTriangle, X } from '@/lib/icons'
import { creditCount, formatCredits, isLowBalance, LOW_BALANCE_CREDITS, useSpendingPower } from '../lib/billing'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import type { AuthUser } from '../store/auth'
import { useTranslation } from 'react-i18next'

// 低余额阈值(积分)。live 实测一轮云对话约几十~上百积分;200 给足充值 runway。owner 可调一行。
// 阈值和「算不算低」的判定都在 @gugu/core/billing —— 这里只是把领域常量按原名再导出,给引用它的
// 调用方和测试留住入口,判断本身不在这个组件里重写一遍。
export const LOW_BALANCE_THRESHOLD = LOW_BALANCE_CREDITS

export function LowBalanceBanner({ user, onRecharge }: { user: AuthUser | null; onRecharge: () => void }) {
  const { t } = useTranslation('settings')
  // 判据是**能花的合计**(会员额度 + 不过期积分),不是不过期积分那一个池子。
  // 只看后者的话,一个周期额度还剩 345 的 max 会员会被弹「积分不足(剩 0.14 积分)」——
  // 线上真实发生过,而他一分钱都不缺、也无需充值。
  // 数来自与侧栏、积分面板、设置页同一个订阅点:横幅报的数字与它们不可能对不上,
  // 「回 app 后刷新」也由它统一负责。取不到 → null → 不弹(不编造假数字)。
  const { power } = useSpendingPower(user)
  const credits = power?.spendable ?? null
  const [dismissed, setDismissed] = useState(false)

  const isLow = credits !== null && isLowBalance(credits)
  // 进入低额态 → 重新允许弹(充值回升后再走低也会重弹);非低额态不动 dismissed。
  useEffect(() => {
    if (isLow) setDismissed(false)
  }, [isLow])

  if (!isLow || dismissed) return null

  return (
    <div
      className="window-no-drag-region"
      data-testid={AUTOMATION_TEST_IDS.lowBalanceBanner}
      role="status"
      style={{
        position: 'fixed', left: '50%', top: 'calc(var(--titlebar-actions-lane) + 8px)',
        transform: 'translateX(-50%)', zIndex: 'var(--z-banner)',
        maxWidth: 420,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-lift)',
        padding: '10px 12px',
        display: 'flex', alignItems: 'center', gap: 10,
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          width: 28, height: 28, borderRadius: 'var(--radius-control)', flexShrink: 0,
          display: 'grid', placeItems: 'center',
          background: 'var(--warn-tint)',
          color: 'var(--warn)',
        }}
      >
        <AlertTriangle size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--font-body)', fontWeight: 600, color: 'var(--text-primary)' }}>
          {t('lowBalance.title', { credits: credits === null ? '--' : formatCredits(credits), count: credits === null ? 0 : creditCount(credits) })}
        </div>
        <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-secondary)' }}>
          {t('lowBalance.description')}
        </div>
      </div>
      <button
        type="button"
        data-testid={AUTOMATION_TEST_IDS.lowBalanceRechargeButton}
        onClick={() => { setDismissed(true); onRecharge() }}
        style={{
          flexShrink: 0, padding: '6px 12px', borderRadius: 'var(--radius-control)',
          border: '1px solid var(--border-strong)', background: 'var(--accent)',
          color: 'var(--text-on-accent)', fontSize: 'var(--font-body)', fontWeight: 600, cursor: 'pointer',
        }}
      >
        {t('lowBalance.recharge')}
      </button>
      <button
        type="button"
        aria-label={t('lowBalance.later')}
        onClick={() => setDismissed(true)}
        style={{
          width: 22, height: 22, flexShrink: 0, display: 'grid', placeItems: 'center',
          borderRadius: 'var(--radius-document)', border: 'none', background: 'transparent', cursor: 'pointer',
          color: 'var(--text-secondary)',
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
}
