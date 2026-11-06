import { Unlink } from '@/lib/icons';

/**
 * 并排两枚页签中间那根线(spec session-page「并排」;owner 2026-10-14「中间的虚线变成一个非常简洁的分屏拆开按钮」):
 * 平时就是普通页签之间那根 16px 短竖线;指上去(或 Tab 到它)变成一颗小圆钮,点了 = 拆开。
 * 骑在右边那枚的左缘上、两边各占一点:按下不起拖,也不亮起哪一枚。
 */
export function PairSeparator({ label, onSeparate }: { label: string; onSeparate: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-pair-separator=""
      className="group/sep absolute top-1/2 left-0 z-20 flex h-6 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center outline-none"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onSeparate();
      }}
    >
      <span className="h-4 w-px bg-foreground opacity-[0.18] transition-opacity group-hover/sep:opacity-0 group-focus-visible/sep:opacity-0" />
      <span className="absolute flex size-5 items-center justify-center rounded-full bg-tab-face text-foreground-muted opacity-0 ring-1 ring-foreground/15 transition-opacity group-hover/sep:opacity-100 group-hover/sep:text-foreground group-focus-visible/sep:opacity-100">
        <Unlink className="size-3.5" />
      </span>
    </button>
  );
}
