import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  TITLEBAR_ACTION_EDGE_GAP_PX,
  TITLEBAR_ACTION_SLOT_GAP_PX,
  TITLEBAR_ACTION_SLOT_WIDTH_PX,
  WINDOW_CONTROL_BAR_HEIGHT_PX,
} from '@/lib/window-chrome';

/**
 * Shared geometry for actions in a task's tab strip. Reserve window controls only at the window edge.
 *
 * 窗口按钮的位置是一格独立的留白(`--titlebar-controls-width`,main.tsx 按平台写的真宽),❌ 算在这一排的内边距里:
 * 内边距跟着这一排走,这一排不让位时它连同按钮一起被顶到窗口按钮底下(10-28 实测:窗口 800、两块并排,
 * 最右那块 247px,「关闭这一块」压着最小化 18px)。
 * 页签只占剩下的(TabStripShell 的滚动区基准 0),所以放不下时让位的是这一排;它被压窄、按钮放不下时挂
 * `data-tabbar-actions-tight`,「在 X 中打开」那半颗收起(index.css),只留「其他打开方式」—— 下拉里点哪个就用哪个打开,
 * 一样都不少。宽到放得下整排时再放回来(按收起前量到的宽度判,❌ 收起后「放得下了」又放回来、来回跳)。
 */
export function TabBarActionRow({
  children,
  atWindowEdge,
}: {
  children?: ReactNode;
  atWindowEdge: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tight = useTightRow(ref);
  return (
    <>
      <div
        ref={ref}
        // 按钮不跟着缩(缩了就量不出「放不下」,10-28 实测关闭钮被压到 18px):放不下只表现为内容比盒子宽。
        className="flex min-w-0 items-center [&>*]:shrink-0"
        // Inline geometry also works outside the skin, whose reset overrides utility-layer spacing.
        style={{
          // 压到最窄时裁在自己这一格里,❌ 伸进窗口按钮那格;留 4px 给按钮的焦点环。
          overflow: 'clip',
          overflowClipMargin: '4px',
          height: `${TITLEBAR_ACTION_SLOT_WIDTH_PX}px`,
          marginBlock: `${(WINDOW_CONTROL_BAR_HEIGHT_PX - TITLEBAR_ACTION_SLOT_WIDTH_PX) / 2}px`,
          alignSelf: 'flex-start',
          paddingInlineStart: `${TITLEBAR_ACTION_SLOT_GAP_PX * 2}px`,
          paddingInlineEnd: `${TITLEBAR_ACTION_EDGE_GAP_PX}px`,
          gap: `${TITLEBAR_ACTION_SLOT_GAP_PX}px`,
        }}
        data-tabbar-actions=""
        data-tabbar-actions-edge={atWindowEdge ? '' : undefined}
        data-tabbar-actions-tight={tight ? '' : undefined}
      >
        {children}
      </div>
      {atWindowEdge ? <div aria-hidden className="shrink-0" style={{ width: 'var(--titlebar-controls-width)' }} data-window-controls-reserve="" /> : null}
    </>
  );
}

/**
 * 这一排放不下(内容比盒子宽)就收。收起后这一排只有内容那么宽,量它自己永远「不够宽」,
 * 所以放回来按能让给它的地方算:它自己加上页签那截(页签本来就先让位)够收起前要的宽度,才放。
 * 内容变了(按钮异步出现、换了名字)、整条变宽变窄都重判。
 */
function useTightRow(ref: RefObject<HTMLDivElement | null>): boolean {
  const [tight, setTight] = useState(false);
  const needed = useRef(0);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const bar = row.closest('.session-tab-bar');
    const tabs = bar?.querySelector<HTMLElement>('[data-tabstrip-scroller]') ?? null;
    // 比边,❌ scrollWidth:overflow:clip 下压进右内边距的那一截不算进 scrollWidth(10-28 实测关闭钮吃掉 6px 边距仍判「放得下」)。
    const over = () => {
      const end = Math.max(...Array.from(row.children, (child) => child.getBoundingClientRect().right));
      return end - (row.getBoundingClientRect().right - TITLEBAR_ACTION_EDGE_GAP_PX);
    };
    const check = () => {
      if (!row.hasAttribute('data-tabbar-actions-tight')) {
        const by = row.children.length ? over() : 0;
        if (by > 0.5) {
          needed.current = row.clientWidth + by;
          setTight(true);
        }
      } else if (row.clientWidth + (tabs?.clientWidth ?? 0) >= needed.current) {
        setTight(false);
      }
    };
    check();
    const resize = new ResizeObserver(check);
    resize.observe(row);
    if (bar) resize.observe(bar);
    const mutation = new MutationObserver(check);
    mutation.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [ref]);
  return tight;
}
