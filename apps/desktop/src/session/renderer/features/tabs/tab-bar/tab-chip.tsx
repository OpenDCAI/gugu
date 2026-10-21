import { forwardRef, useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@renderer/utils/utils';
import { TabCloseButton } from './tab-close-button';
import { tabDensity, type TabDensity } from './tab-density';
import { TabTitle } from './tab-title';

/** Chrome 式页签的高度。40px 带 - 34px 页签 = 顶上那点呼吸,❌ 别把 6 写死。 */
export const SESSION_TAB_HEIGHT_PX = 34;

/**
 * Chrome 的宽度规矩:页签平分可用宽度,少的时候各自到 240px 封顶,多的时候一起缩到 44px 下限
 * (再多就横向滚动)。约束挂在**位**上,页签本体只管 `w-full` 填满。
 *
 * 这条规矩顺带治掉了 #4134 那个病:草稿面板的页签曾经按内容撑开,于是「打开文件」那一枚的标签
 * (一个任意长度的文件名)能一个人吃掉整条 strip,把「+」顶出可视区裁掉 —— 而它是新建页签的唯一
 * 入口。平分 + 封顶 + 截断之后,一枚页签再也撑不开自己那一份,那个成因不复存在。
 */
const TAB_SLOT_STYLE: CSSProperties = {
  display: 'flex',
  height: '100%',
  alignItems: 'flex-end',
  position: 'relative',
  flex: '1 1 200px',
  // 下限 44px:窄到这里就只剩图标(tab-density.ts),再多就横向滚动 + 「全部页签」菜单(tab-bar.tsx)。
  minWidth: '44px',
  maxWidth: '240px',
};

/**
 * 一枚页签在贴条上占的**位**。
 *
 * session-tab-slot 是分隔线与耳朵的锚点:两者都要看**兄弟** slot 的状态(自己或左邻居被选中/悬浮时
 * 线消失、活动 slot 抬到邻居之上),规则在 index.css。
 *
 * ⚠️ 几何一律内联,❌ 不走 utility —— 理由同 <TabStripShell>:tokens.css 里那条未分层的
 * `*{margin:0;padding:0}` 压得过 `@layer utilities`,组件测试的挂载点不在皮肤壳里时会被静默抹平。
 */
export const TabSlot = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(function TabSlot(
  { className, style, children, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn('session-tab-slot', className)}
      style={{ ...TAB_SLOT_STYLE, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
});

export interface TabChipProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
  isActive: boolean;
  /**
   * 分屏时哪个面板握着焦点,只靠标题的明暗区分。只有一列的贴条(草稿工作区面板)恒为 true ——
   * 那里没有「另一个面板」可以夺走焦点。
   */
  isFocusedPane?: boolean;
  /**
   * 并排的一对里排左('start')/ 排右('end'):相接那一边不圆,两枚连成一块(照 Chrome 分屏;spec session-page「并排」)。
   * 这一对没在屏上时(用户正看着别的页签)两枚铺一层浅底,看得出是一对。
   */
  pairRole?: 'start' | 'end';
  /** 纯文本标签;也是关闭钮 aria-label 与默认 tooltip 的底。 */
  label: string;
  /** 跟在标签后面的淡色小字(同名页签的区分路径、diff 的「工作区 / 暂存」)。窄到只剩图标时与标签一起收起。 */
  hint?: string;
  /** tooltip,默认取 label。 */
  title?: string;
  isPreview?: boolean;
  hasError?: boolean;
  /** 前置图标槽(文件图标、扩展 mark、转圈)。 */
  preSlot?: ReactNode;
  /** 覆盖默认的 `<TabTitle>{label}</TabTitle>`(重命名输入框)。 */
  labelSlot?: ReactNode;
  /** 压在关闭钮底下的状态(脏点、git 状态图标)。 */
  statusSlot?: ReactNode;
  closeLabel: string;
  onClose: () => void;
}

/**
 * 一枚页签的**样子** —— 全产品只有这一份。
 *
 * 抽出来不是为了整洁:在它之前,同一个产品里有两套页签视觉 —— 引擎那条贴条是 Chrome 式
 * (34px、只圆上两角、活动页签与内容连体),而新建会话页/项目首页的草稿工作区面板自己另画了一套
 * 四面圆角的 chip + 一条通底的 border-b,正是 Chrome 那一版明令拒绝的形状与线(#6107 C-04,
 * owner 2026-09-21 实机:「居然是老版本的 tab 样式」)。两份实现必然漂移,所以形状只留一个出处。
 *
 * 交互是调用点的事:点击/双击/中键/右键菜单/拖拽都由外面接上去(本组件把 div 的 props 原样透传),
 * 因为「这一枚代表什么」两边不同 —— 引擎那边是 ResolvedTab + TabHost,草稿那边只是一个字符串。
 */
export function TabChip({
  isActive,
  isFocusedPane = true,
  pairRole,
  label,
  hint,
  title,
  isPreview,
  hasError,
  preSlot,
  labelSlot,
  statusSlot,
  closeLabel,
  onClose,
  className,
  ...rest
}: TabChipProps) {
  const density = useTabDensity(preSlot !== undefined && preSlot !== null);
  // 窄到只剩图标时,只有活动页签有关闭钮(浮在正中,图标让开);非活动的**没有**关闭钮 —— 照 Chrome。带状态的也一样
  // (App 页签的角标、编辑器的脏点):状态照画,只是点不到 ×。
  // 摩擦单 F98:56px 的 App 页签上 × 紧挨图标、几乎在正中,透明也照样接点击 —— 想切过去就关掉了它(L6 两次)。
  // 中键、右键菜单照样能关。
  const iconClose = density.value === 'icon' && !statusSlot && isActive;
  const noClose = density.value === 'icon' && !isActive;
  const closeFloats = !isActive && density.value === 'compact' && !statusSlot;
  return (
    <div
      ref={density.ref}
      data-tab-density={density.value}
      data-tab-label={label}
      role="button"
      tabIndex={0}
      title={title ?? label}
      data-tab-active={isActive ? '' : undefined}
      className={cn(
        // Chrome 式页签:34px 高、只圆上面两个角、坐在贴条底部。宽度由外层 <TabSlot> 平分,
        // 这里只管填满 —— ❌ 别退回内容撑开:两枚页签时一枚占半屏、五枚时挤成一团,正是改版前那副样子。
        // @@@radius-tab-ear (Refs #6104) — 9px 不在 shape 表上,是几何例外:页签两只耳朵要与
        // .session-tab-ears 两枚外探伪元素同数,差 1px 接缝就露亮边。❌ 别当"表上多一档"去别处用。
        'group relative flex h-[34px] w-full items-center rounded-t-tab-ear',
        'text-sm text-foreground-muted transition-colors',
        // 非活动:透明贴在条上,hover 给一块底、按下再深一档(product spec
        // 要求静止/悬浮/按下/选中四态齐全)。
        // @@@state-ladder-mix 以前这里自己用 foreground/[0.07] / [0.12] 兑底色 —— 那是因为
        // 当时的阶梯 token 在 gugu 皮肤下会塌成白色。现在 row-* 就是亮暗自适应的叠色,
        // 且与侧栏/菜单/composer 同一深度,不必再自己兑(自己兑的那两个数也比统一档深一倍)。
        !isActive && 'hover:bg-row-hover hover:text-foreground',
        !isActive && 'active:bg-row-press',
        // 活动:取内容区底色 + 两只耳朵 = 与下方内容连体。
        isActive && 'session-tab-ears bg-tab-face',
        // ❌ 别改字重:34px 高的条上换 font-weight 会让标题宽度跳一下,切面板即抖。
        isActive && (isFocusedPane ? 'text-foreground' : 'text-foreground-muted'),
        pairRole === 'start' && 'rounded-tr-none',
        pairRole === 'end' && 'rounded-tl-none',
        pairRole && !isActive && 'bg-row-hover',
        className
      )}
      {...rest}
    >
      <div
        className={cn(
          'flex h-full min-w-0 flex-1 items-center',
          density.value === 'full' && 'gap-2 pr-2 pl-3',
          density.value === 'compact' && 'gap-1 pr-1 pl-2',
          density.value === 'icon' && 'justify-center gap-1 px-1'
        )}
      >
        {iconClose ? (
          // 只剩图标的活动页签:悬浮时关闭钮浮在正中,图标让开(Chrome 窄页签同样只露一个 ×)。
          <span className="flex shrink-0 items-center transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
            {preSlot}
          </span>
        ) : (
          preSlot
        )}
        {density.value === 'icon' && !labelSlot ? null : labelSlot ?? (
          <TabTitle
            isActive={isActive}
            isFocusedPane={isFocusedPane}
            isPreview={isPreview}
            hasError={hasError}
            maxWidth="max-w-none"
            // 关闭钮浮在标题尾巴上时,标题自己淡出(遮罩),钮下透出页签此刻的真实底色 —— 照 Chrome / VS Code。
            className={cn('min-w-0 flex-1 p-0', closeFloats && TITLE_FADE_UNDER_CLOSE)}
          >
            {label}
            {hint ? <span className="ml-1 text-xs text-foreground-muted">{hint}</span> : null}
          </TabTitle>
        )}
        {/* 窄到只剩图标的活动页签:关闭钮也浮起来,图标居中(全名在悬浮提示里)。非活动的那种没有钮,状态照画。 */}
        {noClose ? (
          statusSlot ? <div className="relative flex size-5 shrink-0 items-center justify-center">{statusSlot}</div> : null
        ) : (
          <TabCloseButton
            onClose={onClose}
            ariaLabel={closeLabel}
            statusIndicator={statusSlot}
            floating={closeFloats || iconClose}
            centered={iconClose}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 关闭钮浮起时标题尾巴的淡出(悬浮 / 键盘焦点在页签里时才生效)。遮罩只改标题自己的不透明度,
 * 不画任何底色 —— 所以钮下永远是页签此刻的真实底色。钮 20px 盖住标题最后 20px;淡出在钮前 4px 就到零(缩放抗锯齿不让笔画边缘溢进钮下),过渡 16px。
 */
const TITLE_FADE_UNDER_CLOSE =
  'group-hover:[mask-image:linear-gradient(to_right,#000_calc(100%-40px),transparent_calc(100%-24px))] group-focus-within:[mask-image:linear-gradient(to_right,#000_calc(100%-40px),transparent_calc(100%-24px))]';

/** 这一枚页签此刻多宽 → 该收成哪一档(尺寸变了才重算)。 */
function useTabDensity(hasIcon: boolean): { ref: (el: HTMLDivElement | null) => void; value: TabDensity } {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const next = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setWidth(Math.round(box.width));
    });
    next.observe(el);
    observer.current = next;
  }, []);
  return { ref, value: tabDensity(width, hasIcon) };
}
