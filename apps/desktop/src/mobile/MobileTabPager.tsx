import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject, type UIEvent } from 'react'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { TAB_POSITION_VAR, settledTab, tabPosition } from './settledTab'

// @@@mobile-tab-pager (#6730) — 手机壳的四个 tab 页并排放进一个原生横向 scroll-snap 容器,一页一屏:
// 跟手、惯性、吸附、方向(手指往左 = 露出右边那页)、首尾页不越界(平台自己的 overscroll 效果)、
// 竖滑优先、页内能横滚的东西先滚,全由浏览器给。❌ 自己跟 touchmove 算位移/速度/阻尼 —— #3284 那版
// 只在抬手时判一次位移,拖动时页面不动,方向还判反了。
// 顺序只有一份:MainLayout 交进来的 `tabs`(手机 = MOBILE_TABS「消息 / 伙伴」),底部 tab 栏按同一份排。

// 桌面壳不分页:两层包裹都是 display:contents,各页照旧直接参与主区的 flex 布局;
// 包裹在两种壳里是同一批元素,web 目标跨 720px 断点时各页不重挂。
// inert 只给手机:横滑时相邻页看得见,只能摘掉焦点与点击;桌面上藏着的页自己用 RETAINED_SURFACE_HIDDEN_STYLE 藏。
const CONTENTS: CSSProperties = { display: 'contents' }
const PAGE: CSSProperties = {
  flex: '0 0 100%',
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  overflow: 'hidden',
  scrollSnapAlign: 'start',
  // 一次甩动最多翻一页。
  scrollSnapStop: 'always',
}

export function MobileTabPager({ mobile, tabs, activeTab, covered = false, swipeable, onSettle, tabBarRef, pages }: {
  mobile: boolean
  /** 这一刻有哪几页、什么顺序(底部 tab 栏按同一份排);桌面壳就是 SIDEBAR_TABS。 */
  tabs: readonly SidebarTab[]
  activeTab: SidebarTab
  /** 手机上有一层推在上面(PhoneLayer):每一页都 inert,停着的那页也摘掉焦点与点击。 */
  covered?: boolean
  /** 只在 tab 的浏览层(底部 tab 栏在的地方)能横滑;钻进全屏子页就锁住。 */
  swipeable: boolean
  onSettle: (tab: SidebarTab) => void
  /** 底部 tab 栏:分页器把连续位置写到它身上(TAB_POSITION_VAR),高亮跟手。 */
  tabBarRef: RefObject<HTMLElement | null>
  pages: Partial<Record<SidebarTab, ReactNode>>
}) {
  const pagerRef = useRef<HTMLDivElement>(null)
  // 点击 tab 即时落位;只有手势横滑才走原生跟手、惯性和吸附。
  useLayoutEffect(() => {
    const pager = pagerRef.current
    if (!mobile || !pager) return
    const index = tabs.indexOf(activeTab)
    const left = index * pager.getBoundingClientRect().width
    pager.scrollTo({ left, behavior: 'instant' })
    tabBarRef.current?.style.setProperty(TAB_POSITION_VAR, String(index))
  }, [mobile, tabs, activeTab, tabBarRef])

  // 选中态在页面吸附到位时才切:activeTab 连着 inert、已读门控、返回键路由,拖到一半来回晃时它不该跟着翻。
  // 「到位」按整页对齐判,❌ scrollend:安卓 WebView 114 之前没有这个事件。
  // tab 栏的亮暗不等它:每一帧把连续位置交给 tab 栏,两格的亮度跟着手指此消彼长。
  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const pager = event.currentTarget
    const width = pager.getBoundingClientRect().width
    const position = tabPosition(pager.scrollLeft, width, tabs.length)
    if (position !== null) tabBarRef.current?.style.setProperty(TAB_POSITION_VAR, String(position))
    const tab = settledTab(pager.scrollLeft, width, tabs)
    if (swipeable && !covered && tab && tab !== activeTab) onSettle(tab)
  }

  return (
    <div
      ref={pagerRef}
      data-mobile-tab-pager={mobile || undefined}
      onScroll={mobile ? handleScroll : undefined}
      style={mobile ? {
        flex: 1,
        minHeight: 0,
        display: 'flex',
        overflowX: swipeable ? 'auto' : 'hidden',
        overflowY: 'hidden',
        scrollSnapType: 'x mandatory',
        // 首尾页拖出界只留本地回弹,❌ 链到页面根上触发浏览器的前进/后退手势。
        overscrollBehaviorX: 'contain',
        scrollbarWidth: 'none',
      } : CONTENTS}
    >
      {tabs.map((tab) => (
        <div key={tab} data-mobile-tab-page={mobile ? tab : undefined} inert={mobile && (covered || activeTab !== tab)} style={mobile ? PAGE : CONTENTS}>
          {pages[tab]}
        </div>
      ))}
    </div>
  )
}
