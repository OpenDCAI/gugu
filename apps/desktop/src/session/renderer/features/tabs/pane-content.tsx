import { useDroppable } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { Suspense, useCallback, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPaneDimensionSink, PaneDimensionProvider, type PaneDimensionSink } from './pane-dimension-provider';
import { usePaneContext } from './pane-context';
import { TabBar } from './tab-bar';
import { isUnavailableTabResource, UnavailableTabContent } from './unavailable-tab';
import { RetainedTabContent, useRetainedTabs } from './retained-tab-content';
import { tabFullscreen, WORKSPACE_ANCHOR } from './tab-fullscreen';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';

const CONTENT_FOCUS_SELECTOR = '.native-edit-context, textarea:not([readonly]), webview, [data-browser-page], [contenteditable="true"]';
const FULLSCREEN_STYLE = {
  position: 'fixed', positionAnchor: WORKSPACE_ANCHOR,
  top: 'anchor(top)', bottom: 'anchor(bottom)', left: 'anchor(left)', right: 'anchor(right)',
  zIndex: 'var(--z-pane-fullscreen)',
} as CSSProperties;

/** One actual pane, one strip and one active navigation context. Splits belong to the layout tree. */
export const PaneContent = observer(function PaneContent({
  emptyState, tabLeadingSlot, tabTrailingSlot, actionsSlot, hideTabBar,
  reserveShellRestoreLane, leadingReservePx, contentOverlay,
}: {
  emptyState?: ReactNode;
  tabLeadingSlot?: ReactNode;
  tabTrailingSlot?: ReactNode;
  actionsSlot?: ReactNode;
  hideTabBar?: boolean;
  reserveShellRestoreLane?: boolean;
  leadingReservePx?: number;
  contentOverlay?: ReactNode;
}) {
  const { paneId, pane, isFocusedPane } = usePaneContext();
  const shellRef = useRef<HTMLDivElement | null>(null);
  useCommandProvider(useMemo(() => ({
    scopeId: 'session-sub' as const,
    isActive: (element: HTMLElement | null) => !!element && !!shellRef.current?.contains(element) || isFocusedPane && document.activeElement === document.body,
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
        element.focus();
        if (document.activeElement === element) return;
      }
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
  const unavailable = active && (!pane.registry.has(active.kind) || isUnavailableTabResource(active.resource)) ? active : null;
  const kinds = [...new Set(pane.resolvedTabs.map((tab) => tab.kind))];
  const recent = useRetainedTabs(kinds, active ? [active.kind] : []);
  const retained = new Set([...recent, ...pane.registry.all().filter((provider) => provider.keepMounted && kinds.includes(provider.kind)).map((provider) => provider.kind)]);
  const fullscreen = tabFullscreen.isOn(pane);
  return (
    <div ref={shellRef} className={fullscreen ? 'flex min-w-0 flex-col overflow-hidden bg-background' : 'flex h-full min-w-0 flex-col overflow-hidden'} style={fullscreen ? FULLSCREEN_STYLE : undefined} data-tab-fullscreen={fullscreen ? '' : undefined}
      onMouseUp={(event) => {
        if (event.defaultPrevented || (event.button !== 3 && event.button !== 4)) return;
        const id = pane.resolvedActiveTabId;
        if (!id) return;
        event.preventDefault();
        void pane.go(id, event.button === 3 ? -1 : 1);
      }}>
      {pane.resolvedTabs.length > 0 && !hideTabBar && <TabBar leadingSlot={tabLeadingSlot} tabTrailingSlot={tabTrailingSlot} actionsSlot={actionsSlot} reserveShellRestoreLane={reserveShellRestoreLane} leadingReservePx={leadingReservePx} />}
      <div ref={setContentRef} className="relative min-h-0 min-w-0 flex-1 bg-tab-face">
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
