import { useDroppable } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { createPaneDimensionSink, PaneDimensionProvider, type PaneDimensionSink } from './pane-dimension-provider';
import { usePaneContext } from './pane-context';
import { TabBar } from './tab-bar';
import { isUnavailableTabResource, UnavailableTabContent } from './unavailable-tab';
import { RetainedTabContent, useRetainedTabs } from './retained-tab-content';
import { fullscreenCover, tabFullscreen } from './tab-fullscreen';
import { WINDOW_CONTROL_BAR_HEIGHT_PX } from '@/lib/window-chrome';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';

// 文件编辑器收字的是 `.cm-content`(可编辑时 contenteditable)。浏览器页签的网页是主进程的 view,页签里只有它的占位 `[data-browser-page]`。
const CONTENT_FOCUS_SELECTOR = '.cm-content, textarea:not([readonly]), webview, [data-browser-page], [contenteditable="true"]';
const FULLSCREEN_STYLE = fullscreenCover('anchor(top)', 'anchor(bottom)');
// A paired page's strip is the session's one strip above the pair: it stays on top (PaneTreeView), the page sits under it.
const FULLSCREEN_UNDER_STRIP_STYLE = fullscreenCover(`calc(anchor(top) + ${WINDOW_CONTROL_BAR_HEIGHT_PX}px)`, 'anchor(bottom)');

type PaneContentProps = {
  /**
   * 'all' (default): this pane's strip over its page. While paired the session's one strip spans both pages: the main
   * pane draws it as 'bar' above the pair, each pane its page as 'body' (PaneTreeView, spec session-page「并排」).
   */
  part?: 'all' | 'bar' | 'body';
  emptyState?: ReactNode;
  tabLeadingSlot?: ReactNode;
  tabTrailingSlot?: ReactNode;
  actionsSlot?: ReactNode;
  hideTabBar?: boolean;
  reserveShellRestoreLane?: boolean;
  leadingReservePx?: number;
  contentOverlay?: ReactNode;
};

/** One actual pane: its page, with the session's strip over it unless the strip is drawn above a pair. */
export const PaneContent = observer(function PaneContent({ part = 'all', ...props }: PaneContentProps) {
  return part === 'bar'
    ? <TabBar leadingSlot={props.tabLeadingSlot} tabTrailingSlot={props.tabTrailingSlot} actionsSlot={props.actionsSlot} reserveShellRestoreLane={props.reserveShellRestoreLane} leadingReservePx={props.leadingReservePx} />
    : <PaneBody {...props} hideTabBar={props.hideTabBar || part === 'body'} underStrip={part === 'body'} />;
});

const PaneBody = observer(function PaneBody({
  emptyState, tabLeadingSlot, tabTrailingSlot, actionsSlot, hideTabBar,
  reserveShellRestoreLane, leadingReservePx, contentOverlay, underStrip,
}: Omit<PaneContentProps, 'part'> & { underStrip: boolean }) {
  const { paneId, pane, isFocusedPane } = usePaneContext();
  const shellRef = useRef<HTMLDivElement | null>(null);
  useCommandProvider(useMemo(() => ({
    scopeId: 'session-sub' as const,
    isActive: () => isFocusedPane,
    getCommands: () => ([-1, 1] as const).map((delta) => ({
      id: delta === -1 ? 'app.navigateBack' as const : 'app.navigateForward' as const,
      hideFromPalette: true,
      execute() { const id = pane.resolvedActiveTabId; if (id) void pane.go(id, delta); },
    })),
  }), [pane, isFocusedPane]));
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: `pane-content-${paneId}` });
  const contentRef = useRef<HTMLDivElement | null>(null);
  const setContentRef = useCallback((element: HTMLDivElement | null) => { dropRef(element); contentRef.current = element; }, [dropRef]);
  useEffect(() => {
    pane.setContentFocuser(() => {
      const container = contentRef.current;
      if (!container) return;
      const kind = pane.activeEntry?.kind;
      const layer = kind ? container.querySelector<HTMLElement>(`[data-pane-layer="${CSS.escape(kind)}"]`) : null;
      for (const element of (layer ?? container).querySelectorAll<HTMLElement>(CONTENT_FOCUS_SELECTOR)) {
        if (element.checkVisibility && !element.checkVisibility({ visibilityProperty: true })) continue;
        element.focus();
        if (document.activeElement === element) return;
      }
      container.focus();
    });
    return () => pane.setContentFocuser(null);
  }, [pane]);

  const sinks = useMemo(() => new Map<string, PaneDimensionSink>(), [pane]);
  const sinkFor = (kind: string) => {
    let sink = sinks.get(kind);
    if (!sink) { sink = createPaneDimensionSink(); sinks.set(kind, sink); }
    return sink;
  };
  const active = pane.resolvedTabs.find((tab) => tab.isActive);
  useLayoutEffect(() => {
    // Same-tab navigation changes the page, not its id. A retained guest must
    // relinquish native input to the new page through the existing focuser.
    if (isFocusedPane && shellRef.current?.contains(document.activeElement)) pane.focusActiveContent();
  }, [pane, isFocusedPane, active?.resource]);
  const unavailable = active && (!pane.registry.has(active.kind) || isUnavailableTabResource(active.resource)) ? active : null;
  const kinds = [...new Set(pane.resolvedTabs.map((tab) => tab.kind))];
  const recent = useRetainedTabs(kinds, active ? [active.kind] : [], pane.resolvedTabs.filter((tab) => tab.resource.holdsUnsaved).map((tab) => tab.kind));
  const retained = new Set([...recent, ...pane.registry.all().filter((provider) => provider.keepMounted && kinds.includes(provider.kind)).map((provider) => provider.kind)]);
  const fullscreen = tabFullscreen.isOn(pane);
  return (
    <div ref={shellRef} className={fullscreen ? 'flex min-w-0 flex-col overflow-hidden bg-background' : 'flex h-full min-w-0 flex-col overflow-hidden'} style={fullscreen ? (underStrip ? FULLSCREEN_UNDER_STRIP_STYLE : FULLSCREEN_STYLE) : undefined} data-tab-fullscreen={fullscreen ? '' : undefined}
      onMouseUp={(event) => {
        if (event.defaultPrevented || (event.button !== 3 && event.button !== 4)) return;
        const id = pane.resolvedActiveTabId;
        if (!id) return;
        event.preventDefault();
        void pane.go(id, event.button === 3 ? -1 : 1);
      }}>
      {pane.resolvedTabs.length > 0 && !hideTabBar && <TabBar leadingSlot={tabLeadingSlot} tabTrailingSlot={tabTrailingSlot} actionsSlot={actionsSlot} reserveShellRestoreLane={reserveShellRestoreLane} leadingReservePx={leadingReservePx} />}
      <div ref={setContentRef} data-pane-content="" tabIndex={-1} className="relative min-h-0 min-w-0 flex-1 bg-tab-face">
        <PaneDimensionProvider sink={pane}>
          {isOver && <div className="pointer-events-none absolute inset-0 z-20 bg-foreground/10" />}
          {pane.registry.all().filter((provider) => retained.has(provider.kind)).map((provider) => {
            const Content = provider.TabContent;
            return (
              <RetainedTabContent key={provider.kind} visible={!unavailable && active?.kind === provider.kind} className="absolute inset-0" data-pane-layer={provider.kind} data-pane-layer-key={provider.kind} data-pane-tab={active?.kind === provider.kind ? active?.tabId : undefined}>
                <PaneDimensionProvider sink={sinkFor(provider.kind)}>
                  <Suspense fallback={null}><Content host={pane} ctx={pane.ctx} /></Suspense>
                </PaneDimensionProvider>
              </RetainedTabContent>
            );
          })}
          {unavailable && <UnavailableTabContent tab={unavailable} host={pane} />}
          {pane.resolvedTabs.length === 0 ? emptyState : null}
        </PaneDimensionProvider>
        {contentOverlay}
      </div>
    </div>
  );
});
