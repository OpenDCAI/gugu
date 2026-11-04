import { useEffect, useRef, type ReactNode } from 'react';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';

/**
 * 一节的会话(owner 2026-09-25):默认只露头几条、平铺、没有滑动条;点「显示更多」之后才是一个限高的小窗
 * (「点击『显示更多』之后才会显示滑动条,否则前端压力太大」)。
 * 约五行高(行高 60,max-h-80 让第六行露一截,看得出还能滚),多出来的在窗里滚;
 * 滚到窗底而这一节还有没带回的,就叫调用方再要一批 —— 一直滚能滚完这一节,❌ 截在某个数上。
 * `capped=false`(还没点开,或项目下拉只看某一节)不限高:没点开时只有头几条,只看某一节时整页就是这一节。
 * 滚到窗底后滚轮照常传给页面(❌ overscroll-contain):一页全是小窗,光标停在哪个窗上都得能接着翻页。
 *
 * 样子与咕咕其它清单统一(设计同事 2026-09-25「不统一,参考 design.md」):
 * - 一组行 = 一块**密度面板**(bg-foreground/[0.02],暗色 /[0.03]),❌ 外框、❌ 逐行发丝线(docs/design/ui-visual-spec.md §6.6)
 * - 圆角是印在页上的那一档 rounded-sm(= --radius-document 6px),❌ 12px —— 那是浮起来的卡片(§5.1)
 * - 滚动条用全应用同一条安静的悬浮细条(皮肤的 scrollbar-width: thin),❌ 这里单独改成常驻 ——
 *   design.md 的 Scrollbar:「A quiet overlay scrollbar for panes that keep their own scroll」
 */
export function SessionHistorySectionBox({
  capped,
  hasMore,
  isLoadingMore,
  onReachEnd,
  children,
}: {
  capped: boolean;
  /** 这一节还有没带回的会话。 */
  hasMore: boolean;
  isLoadingMore: boolean;
  onReachEnd: () => void;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // 窗底的哨兵进了窗(提前 120px)就要下一批;要的时候不观察,回来后哨兵若仍在窗里会马上再要 —— 调用方负责去重。
  useEffect(() => {
    const box = boxRef.current;
    const end = endRef.current;
    if (!capped || !hasMore || isLoadingMore || !box || !end) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onReachEnd();
      },
      { root: box, rootMargin: '0px 0px 120px 0px' }
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [capped, hasMore, isLoadingMore, onReachEnd]);

  return (
    <div className="overflow-hidden rounded-sm bg-foreground/[0.02] dark:bg-foreground/[0.03]">
      <div
        ref={boxRef}
        data-testid="session-history-section-box"
        className={cn('px-4', capped && 'max-h-80 overflow-y-auto')}
      >
        {children}
        {capped && hasMore ? (
          <div
            ref={endRef}
            className="flex h-10 items-center justify-center"
            data-testid="session-history-section-loading"
          >
            <Spinner size="sm" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
