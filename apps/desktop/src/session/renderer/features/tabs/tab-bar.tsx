import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { ChevronDown } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { isStripOverflowing, readStripTabs, wheelToHorizontal, type StripTabEntry } from './tab-bar/tab-overflow';
import { readRendererPlatform, shellRestoreLane, WINDOW_CONTROL_BAR_HEIGHT_PX } from '@/lib/window-chrome';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import { PaneDropZone } from './tab-bar/draggable-tab';
import { SESSION_TAB_HEIGHT_PX } from './tab-bar/tab-chip';
import { isUnavailableTabResource, UnavailableTabBarItem } from './unavailable-tab';
import { TabStripMotion } from './tab-bar/tab-motion';
import { useTabOrderPreview } from './tab-bar/use-tab-order-preview';

export const TabBar = observer(function TabBar({
  tabTrailingSlot,
  actionsSlot,
  reserveShellRestoreLane,
  leadingReservePx,
  leadingSlot,
}: {
  /** Rendered immediately after the last tab, before the flexible drop zone. */
  tabTrailingSlot?: ReactNode;
  /** 左端还要让出多宽(单独成窗时让开 mac 的红绿灯)。见 <TabStripShell>。 */
  leadingReservePx?: number;
  /** 页签条最左那一点:一块左上那条放 ⋮⋮(按住整块走),见 <TabStripShell>。 */
  leadingSlot?: ReactNode;
  /** Fixed pane-level controls aligned to the far edge of the bar. */
  actionsSlot?: ReactNode;
  /** 这条页签条是不是贴着主内容区左缘(左边再无聊天栏/分栏)。见 <TabStripShell>。 */
  reserveShellRestoreLane?: boolean;
}) {
  const { paneId, pane } = usePaneContext();

  const resolvedTabs = pane.resolvedTabs;

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const order = useTabOrderPreview(pane, scrollContainerRef);
  const tabsById = new Map(resolvedTabs.map((tab) => [tab.tabId, tab]));

  // 放不下了没有:滚动区尺寸变了、页签数变了才重算(ResizeObserver,❌ 定时量)。
  const [overflowing, setOverflowing] = useState(false);
  const tabCount = resolvedTabs.length;
  useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller) return;
    const measure = () => setOverflowing(isStripOverflowing(scroller));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [tabCount]);

  // 竖着拨滚轮也横着走(VS Code 的贴条);原生 wheel 监听才能 preventDefault(React 的是 passive)。
  useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      const delta = wheelToHorizontal(event);
      if (delta === null || !isStripOverflowing(scroller)) return;
      event.preventDefault();
      scroller.scrollLeft += delta;
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, []);

  return (
    // Any click in the tab bar (select, close, pin, empty space) should return
    // DOM focus to the active content. Child handlers run first; the rAF in
    // focusActiveContent() defers the focus call until after they settle.
    // The inline rename input stops propagation, so it keeps focus while editing.
    // 「+」、「全部页签」与右端那组控制自己开菜单 / 浮层:这时把焦点拉回内容会当场把它们关掉 —— 对话成了
    // 页签之后(#7052)这一格的内容常常就是输入框,它一拿到焦点,刚弹出的菜单就收回去。
    <TabStripShell
      scrollerRef={scrollContainerRef}
      onClick={(event) => {
        if ((event.target as Element).closest('[data-tabstrip-trailing], [data-tabbar-actions], [aria-haspopup], [data-block-grip]')) return;
        pane.focusActiveContent();
      }}
      trailingSlot={tabTrailingSlot}
      dropZone={<PaneDropZone paneId={paneId} />}
      overflowSlot={
        overflowing ? (
          <TabOverflowMenu
            read={() => (scrollContainerRef.current ? readStripTabs(scrollContainerRef.current) : [])}
            onPick={(tabId) => pane.setActiveTab(tabId)}
          />
        ) : null
      }
      actionsSlot={actionsSlot}
      reserveShellRestoreLane={reserveShellRestoreLane}
      leadingReservePx={leadingReservePx}
      leadingSlot={leadingSlot}
    >
      <TabStripMotion scroller={scrollContainerRef} order={order.join('\0')} activeTabId={pane.activeTabId}>
      {order.map((id) => {
        const tab = tabsById.get(id);
        if (!tab) return null;
        if (isUnavailableTabResource(tab.resource) || !pane.registry.has(tab.kind)) {
          return <UnavailableTabBarItem key={tab.tabId} tab={tab} host={pane} />;
        }
        const def = pane.registry.get(tab.kind);
        const TabItemComponent = def.TabBarItem;
        return <TabItemComponent key={tab.tabId} tab={tab} host={pane} ctx={pane.ctx} />;
      })}
      </TabStripMotion>
    </TabStripShell>
  );
});

/** 放不下时贴条右端那枚「全部页签」(照 VS Code 的 Show Opened Editors)。菜单打开时才读一次页签。 */
function TabOverflowMenu({ read, onPick }: { read: () => StripTabEntry[]; onPick: (tabId: string) => void }) {
  const { translate } = useSessionMessages();
  const [entries, setEntries] = useState<StripTabEntry[]>([]);
  const label = translate('tabs.allTabs');
  return (
    <div className="flex h-full shrink-0 items-center" data-tabstrip-overflow="">
      <DropdownMenu onOpenChange={(open) => open && setEntries(read())}>
        <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={label} title={label} />}>
          <ChevronDown className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
          {entries.map((entry) => (
            <DropdownMenuItem key={entry.tabId} onClick={() => onPick(entry.tabId)}>
              <span className={cn('min-w-0 flex-1 truncate', entry.isActive && 'text-foreground')}>{entry.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * 页签条的**几何外壳** —— 顶栏那条 40px 带在工作区面板这一侧的实现。
 *
 * 单独抽出来,是因为这层盒子必须能被判据咬住:上一版几何写在 TabBar 的 JSX 里,而浏览器测试是把
 * <TabBarActionRow> 塞进一个自己搭的 `position:fixed; height:40px` 壳里量对齐 —— 产品这边把整条带
 * 加上 `pt-1.5`(Chrome 式页签)之后,拆分/最大化整体下沉 3px、和贴窗口的固定簇错开,那条测试照样全绿。
 *
 * 规矩:
 *  · **几何一律内联,❌ 不走 utility。** tokens.css 里那条 `*:not(.gugu-skin, …)
 *    { margin:0; padding:0 }` 没进任何 @layer,而无 layer 的声明压得过 `@layer utilities` ——
 *    于是所有 `p-*`/`m-*` 在那层壳外面被静默抹平(实测 `p-4` 算出来是 0)。产品跑在壳里所以看着没事,
 *    测试挂载点不在壳里,量到的就是另一套 CSS。几何内联,两边才是同一份。
 *  · 「页签坐在条底 + 顶上留呼吸」是**页签**的事,所以那点呼吸写在滚动区上,❌ 不写在带上:
 *    写在带上,带里所有东西(包括右端的动作组)一起下沉,而贴窗口的固定簇不会跟着动。
 *  · 活动页签用自己的底色和下方内容连成一体 —— 所以这里**不能**有 border-b:一条通到底的线会把
 *    页签和它装的内容切断,那正是改版前「像分段控件、不像页签」的根。
 *  · 左内缩 12px 不是随手取的:活动页签的左耳朵要往外探 9px(见 index.css .session-tab-ears),
 *    而滚动区是 overflow-x-auto 的裁剪盒 —— 小于 9px,首个页签的耳朵会被切掉。
 *  · 这条带的左端和右端一样,可能贴着另一层 chrome:侧栏收起时,主内容区左上角浮着那枚
 *    「展开侧栏」按钮(零高度浮层里的 absolute 元素,**不占版面**)。所以最左那条页签条要
 *    `reserveShellRestoreLane`,和右端的 `atWindowEdge` 是同一件事的两侧 —— ❌ 别所有分栏都留,
 *    中间那些左边是聊天栏或拖拽把手,留了就在版面中间开一道洞。
 */
export const TAB_STRIP_LEADING_PX = 12;

/**
 * 页签条窄于这个宽度就挂 `data-strip-narrow`:右端那组控制先让位(编程模式换模型那颗只剩厂商图形、模式按钮只剩图标,index.css)。
 * 600 = 那组控制全展开时约 375px(换模型 190 + 模式按钮 74(#7167)+ 输出 / 分享 / 关闭这一块)+ 左缩 12 + 「+」32,
 * 剩一百七八十给页签 —— 再窄,页签就会被挤到 0、整枚躲进「全部页签」(10-10 实测:三块并排一块 323px,任务名那枚看不见)。
 * 原来是 520,右端多了模式按钮这一颗就跟着加上它的宽度,❌ 让页签那截替它让位。
 * 按整条的宽度判,❌ 按页签剩下多少判:让位之后页签那截变宽,又会判成「放得下」翻回去,来回跳。
 */
export const TAB_STRIP_NARROW_PX = 600;

export function TabStripShell({
  scrollerRef,
  onClick,
  children,
  trailingSlot,
  dropZone,
  overflowSlot,
  actionsSlot,
  reserveShellRestoreLane,
  leadingReservePx = 0,
  leadingSlot,
  testId,
}: {
  /** 左端还要让出多宽:单独成窗的那条页签条就是标题栏,mac 的红绿灯压在它左端。 */
  leadingReservePx?: number;
  /**
   * 页签条最左那一点(⋮⋮):摆在第一枚页签左边的留白里,❌ 不挤动页签 —— 那 12px 留白本来就在
   * (首个页签的耳朵要它),拖柄就住在它里面;侧栏收起、让位那枚钮时,它贴着让出来的那一截的右端。
   */
  leadingSlot?: ReactNode;
  /** 放不下时的「全部页签」菜单;在滚动区外面,不跟着滚。 */
  overflowSlot?: ReactNode;
  scrollerRef?: RefObject<HTMLDivElement | null>;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  /** 页签本身。❌ 只放页签:滚动区的**直接**子项就是宽度规矩的载体(见下)。 */
  children?: ReactNode;
  /** 「+」。包装由本组件出,❌ 别在调用点自己糊一个 —— 那样贴条的布局就没有一个能被判据咬住的地方。 */
  trailingSlot?: ReactNode;
  /** 「拖到这个面板」的落点,吃掉页签右边剩下的横向空间。 */
  dropZone?: ReactNode;
  actionsSlot?: ReactNode;
  /** 这条页签条是不是最左那条(左边再无聊天栏/分栏、直抵主内容区左缘)。 */
  reserveShellRestoreLane?: boolean;
  /** 取证用的名字。引擎那条不需要(它由 .session-tab-bar 定位),草稿那条要能与面板空态区分。 */
  testId?: string;
}) {
  const leading = Math.max(
    TAB_STRIP_LEADING_PX,
    reserveShellRestoreLane ? shellRestoreLane(readRendererPlatform()) : 0,
    leadingReservePx
  );
  // 整条多宽:窄了挂标记,右端控制先让位(TAB_STRIP_NARROW_PX)。ResizeObserver,❌ 定时量。
  const barRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const measure = () => setNarrow(bar.getBoundingClientRect().width < TAB_STRIP_NARROW_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={barRef}
      // 页签条的空白处拖窗口,三个平台、每种块都一样(项目块、对话块、App 块原先这里什么都没有);
      // 页签、按钮这些可交互的东西由 index.css 的 @@@4259 规则默认退订,照常能点。
      className="session-tab-bar relative flex shrink-0 items-stretch justify-between bg-tab-strip [-webkit-app-region:drag]"
      data-testid={testId}
      data-strip-narrow={narrow ? '' : undefined}
      style={{
        height: `${WINDOW_CONTROL_BAR_HEIGHT_PX}px`,
        paddingInlineStart: `${leading}px`,
      }}
      onClick={onClick}
    >
      {leadingSlot ? (
        <div
          className="absolute inset-y-0 flex items-center justify-center"
          style={{ insetInlineStart: `${leading - TAB_STRIP_LEADING_PX}px`, width: `${TAB_STRIP_LEADING_PX}px` }}
          data-tabstrip-leading=""
        >
          {leadingSlot}
        </div>
      ) : null}
      <div
        ref={scrollerRef}
        className="flex h-full w-full items-end overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ paddingBlockStart: `${WINDOW_CONTROL_BAR_HEIGHT_PX - SESSION_TAB_HEIGHT_PX}px` }}
      >
        {children}
        {trailingSlot ? (
          // 「+」紧跟最后一枚页签(spec session-page「+ 属于 tab strip」),圆形悬浮反馈与关闭钮同源;
          // 左边那点是它与页签之间的呼吸,不是组间距。它在**滚动区里**,所以跟着页签坐底 ——
          // 它属于 tab strip,不属于顶栏那一排图标。
          // 它不参与收缩(shrink-0):页签会为它让位,而不是反过来把它顶出去被裁掉。
          <div
            // 形状交给按钮组件自己(Button 的 icon-sm 默认就是 rounded-md 档),❌ 不在容器上用
            // [&_button]: 从外面改写 —— design.md 的 radius-capsule 只给 switch/avatar/status
            // dot,不给通用图标按钮(2026-09-22 去掉这条覆写)。
            className="flex h-full shrink-0 items-center"
            style={{ marginInlineStart: '4px' }}
            data-tabstrip-trailing=""
          >
            {trailingSlot}
          </div>
        ) : null}
        {dropZone}
      </div>
      {overflowSlot}
      {actionsSlot}
    </div>
  );
}
