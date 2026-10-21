import { useSessionMessages } from '@renderer/localization/use-session-messages';

// One shape for every badge on this page. Hoisted rather than repeated per badge so adding a
// badge cannot drift the padding, and so the spacing literals are stated once.
const BADGE_BASE = 'rounded-md px-1.5 py-0.5';

/**
 * ❌ 这里原本还有「四态各一枚徽标」与「有可用更新」两枚。#6157 把状态挪到了图标上
 * (`AgentTile`:灰化 / 角标 / 进度环)—— 同一个事实再用一枚文字徽标说第二遍,就是 owner 点名的
 * 那种「一个事实六种说法」。四态的**词**仍然只有一张表(`readingLabelKey`),现在只给读屏用。
 */
export function OutdatedSourceBadge() {
  const { translate } = useSessionMessages();
  return (
    <span
      className={`${BADGE_BASE} bg-background-warning text-[length:var(--font-caption)] text-foreground-warning`}
    >
      {translate('agentsPage.sourceOutdated')}
    </span>
  );
}
