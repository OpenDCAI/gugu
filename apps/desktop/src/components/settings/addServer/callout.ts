import { cn } from '../../../lib/cn'

/**
 * #6264 添加一台机器里那几段「要人看一眼」的话(失败、提醒、装好了、SSH 在问):design.md 的 Callout ——
 * 「A quiet aside on a colored rule」:左边一条 2px 的语义色线 + 一层密度底,❌ 四边框的卡片。
 * 它们都长在「添加一台机器」那一块里、或确认页里,再画一圈框就是 box inside a box。
 * 色线只说状态:danger = 失败(destructive red is a state)、warn = 要人处理的提醒、ok = 装好了、
 * ask = SSH 此刻在问你(墨色:chrome is ink,❌ 借 live 蓝 —— 同屏正在跑的那一步才是 live)。
 */
export type CalloutTone = 'danger' | 'warn' | 'ok' | 'ask'

const RULE: Record<CalloutTone, string> = {
  danger: 'border-[var(--danger)]',
  warn: 'border-[var(--warn)]',
  ok: 'border-[var(--ok)]',
  ask: 'border-[var(--fg)]',
}

export function calloutClassName(tone: CalloutTone): string {
  return cn('flex flex-col gap-2 border-l-2 bg-foreground/[0.025] px-3 py-2 dark:bg-foreground/[0.04]', RULE[tone])
}
