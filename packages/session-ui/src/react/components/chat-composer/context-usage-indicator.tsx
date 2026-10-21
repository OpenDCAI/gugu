import { Button } from '@session-ui/react/primitives/button';
import { Popover } from '@session-ui/react/primitives/popover';
import { cx } from '@session-ui/styles/utilities/cx';
import * as styles from './chat-composer.css';
import { useMessages } from '../../localization/message-provider';

// ── Data type ─────────────────────────────────────────────────────────────────

export interface ContextUsage {
  used: number;
  size: number;
  cost?: { amount: number; currency: string } | null;
  /** Where the current session gets billed. Unknown/subscription must hide provider currency. */
  costSource: 'platform' | 'api-key' | 'subscription' | 'unknown';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export function providerCostForRoute(
  usage: Pick<ContextUsage, 'cost' | 'costSource'>
): { amount: number; currency: string } | null {
  return usage.costSource === 'api-key' ? (usage.cost ?? null) : null;
}

function formatCost(cost: { amount: number; currency: string }, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: cost.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(cost.amount);
  } catch {
    return `${cost.amount} ${cost.currency}`;
  }
}

// ── Indicator ─────────────────────────────────────────────────────────────────
//
// @@@no context ring (2026-09-22,按 design.md 统一) —— 这里原来是一枚百分比圆环
// (`<circle strokeDasharray={pct} 100 />`)。design.md 的 Reject 列表逐字点名:
// 「The stock chat idiom inside our chat: … a percentage context ring」。
// 触发器换成**一行读数**:同一份数字,不需要把一段弧长换算回「还剩多少」。
// 弹层里那条线性条留着 —— 圆环在时它俩画的是同一个分数,现在只剩一个图形表达。

export function ContextUsageIndicator({
  usage,
  disabled,
}: {
  usage: ContextUsage;
  disabled?: boolean;
}) {
  const { locale, translate } = useMessages();
  const fraction = Math.min(1, Math.max(0, usage.used / usage.size));
  const pct = Math.round(fraction * 100);
  const providerCost = providerCostForRoute(usage);

  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={styles.usageTrigger}
            disabled={disabled}
            aria-label={translate('composer.contextWindowUsed', { percent: pct })}
          >
            <span className={cx(styles.usageReading, fraction >= 0.9 && styles.usageReadingWarn)}>
              {formatTokens(usage.used)}/{formatTokens(usage.size)}
            </span>
          </Button>
        }
      />
      <Popover.Content align="end" side="top">
        <Popover.Header>
          <Popover.Title>{translate('composer.contextUsage')}</Popover.Title>
        </Popover.Header>
        <div className={styles.usagePopoverBody}>
          <div className={styles.usageStatsRow}>
            <span className={styles.usagePercent}>{pct}%</span>
            <span className={styles.usageTokenCount}>
              {formatTokens(usage.used)} / {formatTokens(usage.size)} {translate('composer.tokens')}
            </span>
          </div>
          <div className={styles.usageBarTrack} aria-hidden="true">
            <div
              className={cx(styles.usageBarFill, fraction >= 0.9 && styles.usageBarFillWarn)}
              style={{ width: `${pct}%` }}
            />
          </div>
          {providerCost ? (
            <div className={styles.usageCostRow}>
              {translate('composer.cost', { cost: formatCost(providerCost, locale) })}
            </div>
          ) : null}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
