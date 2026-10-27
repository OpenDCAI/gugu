import { useDroppable } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  createPaneDimensionSink,
  PaneDimensionProvider,
  type PaneDimensionSink,
} from '@renderer/features/tabs/pane-dimension-provider';
import { PaneContext, usePaneContext } from '../tabs/pane-context';
import { PairPlacementContext } from './pair-placement-context';
import { paneSlotView, sameKindSide as sameKindSideOf } from './pane-slot-view';
import { MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX, type PaneStore } from './pane-store';
import { TabBar } from './tab-bar';
import { isUnavailableTabResource, UnavailableTabContent } from './unavailable-tab';
import { RetainedTabContent, useRetainedTabs } from './retained-tab-content';

// Monaco 0.55 收字的是 `.native-edit-context`,旁边那个 `ime-text-area` 是只读的:聚焦它 = 看着进了编辑器、字打不进去。
// 浏览器页签的网页是主进程的 view(#7274),页签里只有它的占位 `[data-browser-page]`:聚焦占位 = 把焦点交给网页。
const CONTENT_FOCUS_SELECTOR =
  '.native-edit-context, textarea:not([readonly]), webview, [data-browser-page], [contenteditable="true"]';

function focusActiveContentElement(container: HTMLElement): void {
  for (const el of container.querySelectorAll<HTMLElement>(CONTENT_FOCUS_SELECTOR)) {
    el.focus();
    if (document.activeElement === el) return;
  }
}

/** The content for a single pane: tab bar + content area. */
export const PaneContent = observer(function PaneContent({
  emptyState,
  tabLeadingSlot,
  tabTrailingSlot,
  actionsSlot,
  hideTabBar,
  reserveShellRestoreLane,
  leadingReservePx,
  contentOverlay,
}: {
  /** 页签条左端还要让出多宽(单独成窗时让开 mac 的红绿灯)。 */
  leadingReservePx?: number;
  /** Rendered when the pane has no open tabs (domain-specific, injected by the task view). */
  emptyState?: ReactNode;
  /** Before the first tab, in the strip's leading gap (a block's ⋮⋮, #7052). */
  tabLeadingSlot?: ReactNode;
  /** Rendered immediately after the last tab in the scrollable tab strip. */
  tabTrailingSlot?: ReactNode;
  /** Rendered in the tab bar action area (domain-specific, injected by the task view). */
  actionsSlot?: ReactNode;
  /** Hide the tab bar entirely (chat column hosts a single conversation with its own header). */
  hideTabBar?: boolean;
  /** 这条页签条贴着主内容区左缘,要给收起态的「展开侧栏」浮动按钮让位(见 <TabStripShell>)。 */
  reserveShellRestoreLane?: boolean;
  /** Drawn over the content region, under the tab bar (the edge drop zones while a tab is dragged, #7052). */
  contentOverlay?: ReactNode;
}) {
  const paneContext = usePaneContext();
  const { paneId, pane } = paneContext;
  const { setNodeRef: setContentDropRef, isOver: isOverContent } = useDroppable({
    id: `pane-content-${paneId}`,
  });
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    pane.setContentFocuser(() => {
      const container = contentRef.current;
      if (!container) return;
      // 并排时两层都可聚焦:只在拿着焦点那一枚的那一层里找,❌ 按 DOM 顺序落进另一边(spec session-page「并排」)。
      const active = pane.resolvedActiveTabId;
      const kind = pane.activeEntry?.kind;
      const layer =
        (active ? container.querySelector<HTMLElement>(`[data-pane-tab="${CSS.escape(active)}"]`) : null) ??
        (kind ? container.querySelector<HTMLElement>(`[data-pane-layer="${CSS.escape(kind)}"]`) : null);
      focusActiveContentElement(layer ?? container);
    });
    return () => pane.setContentFocuser(null);
  }, [pane]);

  const setContentRef = useCallback(
    (el: HTMLDivElement | null) => {
      setContentDropRef(el);
      contentRef.current = el;
    },
    [setContentDropRef]
  );

  // 每种页签一层内容、各量各的尺寸(终端按自己那一半算行列):并排时只是把两层摆到左右,❌ 换父节点 —— 换了终端、对话会整个重挂。
  const layerSinks = useMemo(() => new Map<string, PaneDimensionSink>(), [pane]);
  const layerSink = (kind: string): PaneDimensionSink => {
    let sink = layerSinks.get(kind);
    if (!sink) {
      sink = createPaneDimensionSink();
      layerSinks.set(kind, sink);
    }
    return sink;
  };

  const hasAnyTab = pane.resolvedTabs.length > 0;
  const activeTab = pane.resolvedTabs.find((tab) => tab.isFocused ?? tab.isActive);
  const activeKind = activeTab?.kind ?? null;
  const unavailableActiveTab =
    activeTab &&
    (isUnavailableTabResource(activeTab.resource) || !pane.registry.has(activeTab.kind))
      ? activeTab
      : null;
  // 并排(spec session-page「并排」):两页左右(或上下)摆开,中间一条可拖的分界。每种页签一层内容,
  // 两页是同一种(两个文件、两个网页)时另一页单独再挂一份那种页签的内容(paneSlotView),各管各的那一枚。
  const pair = pane.pairShown ? pane.livePair : null;
  const slots = pair ? pane.pairSlots : null;
  const anchorKind = pair ? (pane.entries.get(pair.anchor)?.kind ?? null) : null;
  const sideKind = pair ? (pane.entries.get(pair.side)?.kind ?? null) : null;
  const sameKindSide = sameKindSideOf(pane);
  // 两份格子视图跟这一格同生同灭(❌ 随那一对重建:内容挂上时就把格子记下了,换一份它看不到)。
  const slotViews = useMemo(() => ({ rest: paneSlotView(pane, 'rest'), side: paneSlotView(pane, 'side') }), [pane]);
  // 窗口缩窄之后存着的份额可能让一边窄过最窄 / 最矮:画的时候按此刻的大小卡住(份额本身不改,宽回来照旧)。
  const vertical = slots?.vertical ?? false;
  const extent = vertical ? pane.dimensions?.height : pane.dimensions?.width;
  const minShare = extent ? Math.min(0.5, (vertical ? MIN_PANE_HEIGHT_PX : MIN_PANE_WIDTH_PX) / extent) : 0;
  const split = pair ? `${(Math.min(1 - minShare, Math.max(minShare, pane.pairShare)) * 100).toFixed(3)}%` : null;
  const slotStyle = (tabId: string): CSSProperties => {
    const first = slots?.first === tabId;
    if (!vertical) return first ? { top: 0, bottom: 0, left: 0, width: split! } : { top: 0, bottom: 0, left: split!, right: 0 };
    return first ? { left: 0, right: 0, top: 0, height: split! } : { left: 0, right: 0, top: split!, bottom: 0 };
  };
  // 这种页签自己摆两页(网页):那一层铺满整格、看得到这一格的全部页签,每页摆在哪由它自己读;❌ 另起一份。
  const selfPlacedKind =
    sameKindSide && sideKind && pane.registry.has(sideKind) && pane.registry.get(sideKind).placesPairItself ? sideKind : null;
  const placeInPair = (tabId: string): CSSProperties | null =>
    slots && (tabId === slots.first || tabId === slots.second) ? slotStyle(tabId) : null;
  /** 这一种页签那一层此刻摆的是这一对里的哪一枚(没在这一对里 = null)。 */
  const layerTabId = (kind: string): string | null =>
    pair ? (kind === anchorKind ? pair.anchor : kind === sideKind ? pair.side : null) : null;
  const retained = useRetainedTabs(
    [...new Set(pane.resolvedTabs.map((tab) => tab.kind))],
    pair ? [anchorKind, sideKind].filter((kind): kind is string => kind !== null) : activeKind ? [activeKind] : [],
  );

  if (!hasAnyTab) {
    return (
      <div ref={setContentRef} className="relative h-full">
        {isOverContent && (
          <div className="pointer-events-none absolute inset-0 z-20 bg-foreground/10" />
        )}
        {emptyState}
        {contentOverlay}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {!hideTabBar && (
        <TabBar
          leadingSlot={tabLeadingSlot}
          tabTrailingSlot={tabTrailingSlot}
          actionsSlot={actionsSlot}
          reserveShellRestoreLane={reserveShellRestoreLane}
          leadingReservePx={leadingReservePx}
        />
      )}
      {/* bg-tab-face 与活动页签同一个 token —— 这是「连体」成立的**前提**,不是装饰:
          两边一旦不同色,页签底下就会出现一条色阶断层,耳朵也就无从谈起。 */}
      <div ref={setContentRef} className="relative min-h-0 min-w-0 flex-1 bg-tab-face">
        {/*
         * PaneDimensionProvider is placed here (below the TabBar, not around
         * the entire PaneContent) so its ResizeObserver only measures the
         * content region. This ensures the TabBar height is never included in
         * PTY grid calculations.
         */}
        <PaneDimensionProvider sink={pane}>
          {isOverContent && (
            <div className="pointer-events-none absolute inset-0 z-20 bg-foreground/10" />
          )}
          {pane.registry.all().filter((def) => retained.has(def.kind)).map((def) => {
            const ContentComponent = def.TabContent;
            const pairedTabId = layerTabId(def.kind);
            const isActive = pair ? pairedTabId !== null : unavailableActiveTab === null && activeKind === def.kind;
            const placesPair = def.kind === selfPlacedKind;
            const host = def.placesPairItself ? pane : slotViews.rest;
            return (
              <ContentLayer
                key={def.kind}
                layerKey={def.kind}
                kind={def.kind}
                pane={pane}
                host={host}
                paneContext={paneContext}
                tabId={placesPair ? null : pairedTabId}
                style={pairedTabId && !placesPair ? slotStyle(pairedTabId) : { inset: 0 }}
                visible={isActive}
                sink={layerSink(def.kind)}
              >
                <PairPlacementContext.Provider value={placesPair ? placeInPair : null}>
                  {/* 页签内容是任务页入口登记的懒组件(@@@tab-views):第一次用到时可能还在载(桌面空闲时已预热),载的那一下这一层先空着。 */}
                  <Suspense fallback={null}>
                    <ContentComponent host={host} ctx={pane.ctx} />
                  </Suspense>
                </PairPlacementContext.Provider>
              </ContentLayer>
            );
          })}
          {sameKindSide && sideKind && !selfPlacedKind ? (
            (() => {
              const def = pane.registry.get(sideKind);
              const ContentComponent = def.TabContent;
              return (
                <ContentLayer
                  key={`${sideKind}#side`}
                  layerKey={`${sideKind}#side`}
                  kind={sideKind}
                  pane={pane}
                  host={slotViews.side}
                  paneContext={paneContext}
                  tabId={sameKindSide}
                  style={slotStyle(sameKindSide)}
                  visible
                  sink={layerSink(`${sideKind}#side`)}
                >
                  <Suspense fallback={null}>
                    <ContentComponent host={slotViews.side} ctx={pane.ctx} />
                  </Suspense>
                </ContentLayer>
              );
            })()
          ) : null}
          {split ? <PairDivider pane={pane} at={split} vertical={vertical} containerRef={contentRef} /> : null}
          {unavailableActiveTab && !pair ? (
            <UnavailableTabContent tab={unavailableActiveTab} host={pane} />
          ) : null}
        </PaneDimensionProvider>
        {contentOverlay}
      </div>
    </div>
  );
});

/**
 * 一种页签的一层内容。并排时它摆在这一对里它那一枚的位置;点进去(或用键盘 Tab 进去)焦点就到那一枚
 * (照 Chrome:点一下非激活的那一侧它就激活)。另一页单独挂的那份(同一种页签并排时)给里面的内容换一份只露出它那一枚的格子。
 */
const ContentLayer = observer(function ContentLayer({
  layerKey,
  kind,
  pane,
  host,
  paneContext,
  tabId,
  style,
  visible,
  sink,
  children,
}: {
  layerKey: string;
  kind: string;
  pane: PaneStore;
  host: PaneStore;
  paneContext: ReturnType<typeof usePaneContext>;
  tabId: string | null;
  style: CSSProperties;
  visible: boolean;
  sink: PaneDimensionSink;
  children: ReactNode;
}) {
  const focusTab = tabId && tabId !== pane.activeTabId ? () => pane.setActiveTab(tabId) : undefined;
  const contextValue = useMemo(
    () => (host === pane ? null : { ...paneContext, pane: host }),
    [host, pane, paneContext]
  );
  const body = <PaneDimensionProvider sink={sink}>{children}</PaneDimensionProvider>;
  // 始终包一层(❌ 只在换了格子视图时才包):包与不包来回换,里面的内容会整个重挂(网页重新加载)。
  return (
    <RetainedTabContent
      className="absolute"
      visible={visible}
      style={style}
      data-pane-layer={kind}
      data-pane-layer-key={layerKey}
      data-pane-tab={tabId ?? undefined}
      onPointerDownCapture={focusTab}
      onFocusCapture={focusTab}
    >
      <PaneContext.Provider value={contextValue ?? paneContext}>{body}</PaneContext.Provider>
    </RetainedTabContent>
  );
});

/**
 * 并排两页中间那条分界(spec session-page「并排」):拖它改前一页(左 / 上)占几成,两边各守最窄 / 最矮;
 * 双击回一半一半。样子照 ResizableHandle:1px 线,两侧各 4px 好抓。
 */
const PairDivider = observer(function PairDivider({
  pane,
  at,
  vertical,
  containerRef,
}: {
  pane: PaneStore;
  at: string;
  vertical: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const extent = vertical ? rect.height : rect.width;
      if (extent <= 0) return;
      const min = Math.min(0.5, (vertical ? MIN_PANE_HEIGHT_PX : MIN_PANE_WIDTH_PX) / extent);
      const ratio = vertical ? (moveEvent.clientY - rect.top) / extent : (moveEvent.clientX - rect.left) / extent;
      pane.setPairRatio(Math.min(1 - min, Math.max(min, ratio)));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      data-pair-divider=""
      className={
        vertical
          ? 'absolute inset-x-0 z-10 h-px -translate-y-1/2 cursor-row-resize bg-[var(--border-subtle)] after:absolute after:inset-x-0 after:top-1/2 after:h-2 after:-translate-y-1/2'
          : 'absolute inset-y-0 z-10 w-px -translate-x-1/2 cursor-col-resize bg-[var(--border-subtle)] after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2'
      }
      style={vertical ? { top: at } : { left: at }}
      onPointerDown={onPointerDown}
      onDoubleClick={() => pane.setPairRatio(null)}
    />
  );
});
