import { X } from '@/lib/icons'

import { cn } from '@renderer/utils/utils'

export function TabCloseButton({
  onClose,
  ariaLabel,
  statusIndicator,
  floating,
  centered,
}: {
  onClose: () => void;
  ariaLabel: string;
  statusIndicator?: React.ReactNode;
  /**
   * 窄页签上的非活动页签(tab-density.ts 的 compact / icon):关闭钮不占位,悬浮时浮在右端出现。
   * **不垫底**:底下的标题尾巴由标题自己淡出(TabChip 的遮罩,照 Chrome / VS Code),钮下透出的就是页签此刻的底色
   * —— 静止、悬浮、按下、活动、明暗两套都天然一致。❌ 垫一块「贴条色」的圆:页签悬浮/活动时底色不是贴条色,接缝一眼可见。
   * ❌ 悬浮时让标题让位:那会让标题一跳一跳。
   */
  floating?: boolean;
  /** 只剩图标的那一档:钮浮在正中(图标悬浮时让开),而不是贴右。 */
  centered?: boolean;
}) {
  return (
    <div
      className={cn(
        'relative flex size-5 shrink-0 items-center justify-center',
        floating && 'absolute top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        floating && (centered ? 'left-1/2 -translate-x-1/2' : 'right-1')
      )}
      data-tab-close-floating={floating ? '' : undefined}
    >
      {/* 状态(转圈、脏点、git 图标、角标)与 × 同坑,× 露面时它让开 —— 显隐判据必须与下面的钮逐字对齐。
          以前只在悬浮时让开:活动页签的 × 是常驻的,于是不悬浮时「运行中」的转圈与 × 叠成一团(owner 实机圈出)。
          让开的时候也停转:看不见的转圈不该让整窗一直出帧。 */}
      {statusIndicator ? (
        <span className="flex items-center justify-center transition-opacity group-hover:opacity-0 group-data-[tab-active]:opacity-0 group-hover:[--gugu-animation-surface-paused:paused] group-data-[tab-active]:[--gugu-animation-surface-paused:paused]">
          {statusIndicator}
        </span>
      ) : null}
      {/* Chrome 的关闭钮:圆形,活动页签上常驻,其余页签悬浮才出现。
          @@@state-ladder-mix 底色走 row-*(叠色,亮暗自适应、与全产品同深度)。
          ❌ 仍然别用 bg-background-2 —— 那一档在 gugu 皮肤下会塌成白色,等于没有悬浮反馈。 */}
      <button
        type="button"
        className="absolute inset-0 flex items-center justify-center rounded-full text-foreground-muted opacity-0 transition-opacity group-hover:opacity-100 group-data-[tab-active]:opacity-100 hover:bg-row-hover hover:text-foreground active:bg-row-press"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={ariaLabel}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
