// 页签变窄时怎么让位(照 Chrome / VS Code 的 shrink 行为):
//  · full    —— 图标 + 标题 + 关闭钮(关闭钮在非活动页签上悬浮才出现,但照样占位,悬浮时标题不跳);
//  · compact —— 非活动页签的关闭钮不再占位(悬浮时浮在右端出现),标题拿回那 20px;内边距收一档;
//               活动页签照旧留着关闭钮(Chrome:活动页签总能直接关);
//  · icon    —— 只剩图标,完整标题在悬浮提示里(Chrome 窄到极限时的样子)。没有图标的页签不进这一档:
//               一枚什么都不画的页签认不出是什么,宁可截断标题。
// 判据只看这一枚页签此刻的宽度(ResizeObserver,尺寸变了才算一次;❌ 定时量)。
export type TabDensity = 'full' | 'compact' | 'icon';

/** 宽度 ≤ 这个数就收成 compact:三枚页签挤在 ~500px 的分栏里时正好落在这一档。 */
export const TAB_COMPACT_MAX_PX = 132;
/** 宽度 ≤ 这个数就只剩图标。 */
export const TAB_ICON_MAX_PX = 60;

export function tabDensity(widthPx: number, hasIcon: boolean): TabDensity {
  if (widthPx <= 0) return 'full';
  if (hasIcon && widthPx <= TAB_ICON_MAX_PX) return 'icon';
  if (widthPx <= TAB_COMPACT_MAX_PX) return 'compact';
  return 'full';
}
