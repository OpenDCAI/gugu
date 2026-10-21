import type { CSSProperties } from 'react'
import type { TFunction } from 'i18next'
import { formatNumber } from '@/i18n'

/** 13,300,000,000 → 「133亿」/「13.3B」:数量级比个位数重要,读的人一眼要知道是「亿」还是「万」。 */
export function compact(value: number): string {
  return formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 })
}

export function plain(value: number, fractionDigits = 0): string {
  return formatNumber(value, { maximumFractionDigits: fractionDigits })
}

/** 秒 → 「45 分钟」「3.2 小时」「60 小时」。不到 10 小时留一位小数,再多就取整。 */
export function duration(seconds: number, t: TFunction<'settings'>): string {
  if (seconds < 3600) return t('usage.minutes', { count: Math.round(seconds / 60), value: plain(Math.round(seconds / 60)) })
  const hours = seconds / 3600
  return t('usage.hours', { value: plain(hours, hours < 10 ? 1 : 0) })
}

/**
 * 图表里由数据决定的几何(柱高、条宽、色带占比)只能走 style —— 它们不是布局常量,
 * 写不成类名。集中在这几个工厂里,组件里不散落 inline 几何。
 */
export function heightPx(px: number): CSSProperties {
  return { height: px }
}
export function swatch(color: string): CSSProperties {
  return { background: color }
}
export function leftPct(fraction: number): CSSProperties {
  return { left: `${fraction * 100}%` }
}

export const HEAT_SCALE = [0, 1, 2, 3, 4].map((level) => `var(--usage-heat-${level})`)
