// 「用户能用多少」这句话的**唯一**写法。
//
// 以前侧栏、积分面板、设置里的额度页各拼各的:同样两个数(余额、窗口余量)拼出三种说法,
// 其中还有一种是不成立的 —— 余额 30 而窗口还剩 200 时报「还剩 200 积分」。
// 现在句子只有这一处,数只来自 core 的 deriveSpendingPower(它取两道闸里小的那个)。
import type { SpendingPower } from '@gugu/core/billing'
import { quotaWindowLabel } from './quota'
import { formatNumber, getLocaleSnapshot, i18n, type SupportedLocale } from '@/i18n'

type SpendingPowerLocale = SupportedLocale

/** 低于这个数就没法用两位小数如实写出来。 */
const SMALLEST_SHOWN_CREDITS = 0.01

/**
 * 积分显示到**小数点后两位**(owner 2026-08-17 定)。
 *
 * 为什么不再是整数:一个积分等于一美元牌价用量(官方计价口径),于是单笔调用普遍在
 * 0.0x 量级 —— 只显示整数的话,整张用量流水会清一色是同一个占位符,等于什么都没说。
 *
 * 尾随的 0 不补:余额 1200 就写 1,200,不写 1,200.00。「支持两位小数」是**能写得下**,
 * 不是每个数都要拖两位。
 *
 * ❌ 真实扣费永远不许显示成 0。两位小数写不下的正数走 `<0.01` —— 这条是从上一版
 * (整数 + `<1`)继承来的,当时就已经踩过:把一笔真花掉的钱印成 0,用户对不上账。
 */
export function formatCredits(
  credits: number,
  locale: SpendingPowerLocale = getLocaleSnapshot().resolvedLocale,
): string {
  if (credits > 0 && credits < SMALLEST_SHOWN_CREDITS) {
    return `<${formatNumber(SMALLEST_SHOWN_CREDITS, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }, locale)}`
  }
  return formatNumber(credits, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }, locale)
}

/**
 * 英文单复数(credit / credits)按**写出来的那个数**取:0.999 显示成「1」,拿原值去选就成了「1 credits」。
 * `<0.01` 那一档四舍五入成 0,照样选复数。
 */
export function creditCount(credits: number): number {
  return Math.round(credits * 100) / 100
}

/** 流水与余额同一把尺:同一个数在两处不该长得不一样。 */
export function formatUsageCredits(
  credits: number,
  locale: SpendingPowerLocale = getLocaleSnapshot().resolvedLocale,
): string {
  return formatCredits(credits, locale)
}

/** 距离恢复还有多久;已经到点了就说「随时」。 */
export function formatUntil(
  at: Date,
  now: Date = new Date(),
  locale: SpendingPowerLocale = getLocaleSnapshot().resolvedLocale,
): string {
  const t = i18n.getFixedT(locale, 'settings')
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000)
  if (minutes <= 0) return t('credits.spending.anyTime')
  if (minutes < 60) return t('credits.spending.minutesLater', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t('credits.spending.hoursLater', { count: hours })
  const days = Math.round(hours / 24)
  return t('credits.spending.daysLater', { count: days })
}

export interface SpendingPowerCopy {
  /** 余额下面那一行:此刻真正花得出去多少,或者两池皆空时怎么恢复。 */
  rate: string
  /** 两种积分各剩多少。spec 要求同屏展示时用户必须分得出,所以这一句不是可选的装饰。 */
  breakdown: string
  /** 连余额一起的完整一句,给只放得下一行的地方(侧栏 tooltip)。 */
  sentence: string
  blocked: boolean
}

export function describeSpendingPower(
  power: SpendingPower,
  now: Date = new Date(),
  locale: SpendingPowerLocale = getLocaleSnapshot().resolvedLocale,
): SpendingPowerCopy {
  const t = i18n.getFixedT(locale, 'settings')
  const rate = describeRate(power, now, locale)
  const breakdown = t('credits.spending.breakdown', {
    period: formatCredits(power.periodCredits, locale),
    wallet: formatCredits(power.walletCredits, locale),
  })
  return {
    rate,
    breakdown,
    // 侧栏只放得下一行,所以那一行报**合计** —— 报不过期积分那一个池子,正是线上把一个
    // 额度还剩 345 的 max 会员写成「还有 0.14 积分」的写法。
    sentence: t('credits.spending.sentence', { credits: formatCredits(power.spendable, locale), count: creditCount(power.spendable), rate }),
    blocked: power.blockedBy !== null,
  }
}

function describeRate(power: SpendingPower, now: Date, locale: SpendingPowerLocale): string {
  const t = i18n.getFixedT(locale, 'settings')
  const windowLabel = quotaWindowLabel(power.period.hours, locale)
  switch (power.blockedBy) {
    case null:
      // 报的是两个池子的**合计**:周期额度还有就还能花,不必等、也不必充。
      return t('credits.spending.available', {
        window: windowLabel,
        credits: formatCredits(power.spendable, locale),
        count: creditCount(power.spendable),
      })
    case 'exhausted':
      // 两条出路都成立,一起说:周期额度会自己回来,充值加量包则立刻可用。
      // ❌ 只说其中一条 —— 只说「去充值」会让人白花钱,只说「等刷新」会让人干等。
      return power.held > 0
        ? t('credits.spending.exhaustedHeld', {
          credits: formatCredits(power.held, locale),
          available: formatUntil(power.period.freesAt, now, locale),
        })
        : t('credits.spending.exhausted', {
          available: formatUntil(power.period.freesAt, now, locale),
        })
  }
}
