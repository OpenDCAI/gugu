import {
  closestCenter,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDndContext,
  useSensor,
  useSensors,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useVirtualizer } from '@tanstack/react-virtual';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type SidebarRow } from '@renderer/features/sidebar/sidebar-store';
import { getSessionPageStore } from '@renderer/features/sessions/stores/session-selectors';
import { useParams, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { getPortalContainerOrBody } from '@renderer/lib/portal-container';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { cn } from '@renderer/utils/utils';
import { lastRowScrollTarget } from './last-row-scroll-target';
import { sessionKeyboardNav } from './session-keyboard-nav';
import { sidebarGroupInsetX } from './sidebar-primitives';
import { useSidebarScrollTargets } from './sidebar-scroll-context';
import { navNodeKey } from './sidebar-store';
import { SidebarProjectItem } from './project-item';
import { SidebarSessionItem } from './sidebar-session-item';
import { SidebarMoreRow } from './sidebar-more-row';
import { SidebarStateHeader } from './sidebar-state-header';
import { ProjectTopicsSlot } from '@renderer/lib/chat-slot';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';

// Task rows have a fixed height; projects are measured as their topic branch expands.
const ROW_HEIGHT = 32;
// @@@sidebar-label-size — 状态标题的字从 11px 放大到 13px,行也跟着从 24 松到 28,
// 否则 32px 的正文行夹着 24px 的标题槽,标题会显得被压扁。与 ROW_HEIGHT 同理:
// 这是虚拟滚动的排版依据,改了标题的视觉高度就必须同步改这里。
const STATE_HEADER_HEIGHT = 28;

export const SidebarVirtualList = observer(function SidebarVirtualList() {
  const rows = sidebarStore.sidebarRows;
  const { currentView } = useWorkspaceSlots();
  const { params: sessionParams } = useParams('session');
  const { params: projectParams } = useParams('project');

  // @@@sidebar-single-scroller — 滚动容器不归本列表所有,它是侧栏正文那一个共用容器
  // (见 sidebar-scroll-context)。本列表只是容器里的一段,因此要把「这一段从容器顶端起算的
  // 偏移」作为 scrollMargin 告诉 virtualizer,并在行的绝对定位里把它减回去。
  const { scroller, content: scrollContent } = useSidebarScrollTargets();
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const initialPointerYRef = useRef<number | null>(null);
  const dragPointerYRef = useRef<number | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragPointerY, setDragPointerY] = useState<number | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const activeSessionProjectExpanded =
    currentView === 'session' && sessionParams.projectId && sessionParams.sessionId
      ? sidebarStore.expandedProjectIds.has(sidebarStore.rowOfSession(sessionParams.projectId, sessionParams.sessionId) ?? '')
      : null;
  // Only project rows are draggable; status grouping owns task order, so tasks and group headers are not
  // sortable. SortableContext therefore holds project ids only.
  const projectDndIds = useMemo(
    () => rows.filter((r) => r.kind === 'project').map(rowToDndId),
    [rows]
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey: (index) => rowToDndId(rows[index]),
    getScrollElement: () => scroller,
    estimateSize: (index) =>
      rows[index]?.kind === 'state-header' ? STATE_HEADER_HEIGHT : ROW_HEIGHT,
    overscan: 8,
    scrollMargin,
  });

  // 偏移会被上方任何一处布局变化改写(「置顶」分区展开/收起、项目分区标题、窗口高度),
  // 而那些分区各自是独立的 observer——它们重渲染时本组件不会跟着重渲染。所以靠观察共用
  // 容器与其内容层的尺寸来重测,而不是挂在某个 React 依赖上。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !scroller) return;
    const measure = () => {
      const next =
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      // 阈值不是「差不多就行」:内容层的高度变化本身也会触发观察,若无条件 setState,
      // 每次测量都排一次重渲染 → 再触发一次观察,成环。
      setScrollMargin((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    if (scrollContent) observer.observe(scrollContent);
    return () => observer.disconnect();
  }, [scroller, scrollContent]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // 把某一行滚进视野。末行不能直接交给 virtualizer.scrollToIndex —— 理由与算法见
  // lastRowScrollTarget;其余行走 virtualizer 原路。
  const scrollRowIntoView = useCallback(
    (index: number) => {
      const element = virtualizer.scrollElement;
      if (index !== virtualizer.options.count - 1 || !element) {
        virtualizer.scrollToIndex(index, { align: 'auto' });
        return;
      }
      // align='auto' 的语义(已整行可见就不动)由 lastRowScrollTarget 承担。
      const target = lastRowScrollTarget({
        listEnd: virtualizer.options.scrollMargin + virtualizer.getTotalSize(),
        rowHeight:
          rowsRef.current[index]?.kind === 'state-header' ? STATE_HEADER_HEIGHT : ROW_HEIGHT,
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
      });
      if (target !== null) element.scrollTo({ top: target });
    },
    [virtualizer]
  );

  // Expanding the active task's project happens on the navigation itself
  // (NavigationStore._applyNavigation → sidebarStore.revealActiveSession), not here: this list
  // remounts without any navigation, and an effect would re-open a project the user folded.

  // Scroll the active project/task into view only when the navigation target itself
  // changes, plus the active task's project expansion state. Re-running on every
  // `rows` change would yank the user back to the active row whenever the
  // sidebar mutates (e.g. deleting an unrelated task), but direct navigation to a
  // task in a collapsed project needs one rerun after `ensureProjectExpanded`.
  useEffect(() => {
    let targetProjectId: string | null = null;
    let targetSessionId: string | null = null;

    if (currentView === 'session') {
      targetProjectId = sessionParams.projectId;
      targetSessionId = sessionParams.sessionId;
    } else if (currentView === 'project') {
      targetProjectId = projectParams.projectId;
    }

    if (!targetProjectId) return;

    if (targetSessionId) {
      const activeSession = getSessionPageStore(targetProjectId, targetSessionId);
      if (activeSession?.data.isPinned) {
        return;
      }
    }

    // Tasks don't render as rows — for a task target, scroll to its first conversation row.
    const activeIndex = rowsRef.current.findIndex((row) => {
      if (targetSessionId) {
        return (
          row.kind === 'conversation' &&
          row.sessionId === targetSessionId &&
          row.projectId === targetProjectId
        );
      }
      return row.kind === 'project' && row.projectId === targetProjectId;
    });

    if (activeIndex >= 0) {
      scrollRowIntoView(activeIndex);
    }
  }, [
    currentView,
    sessionParams.projectId,
    sessionParams.sessionId,
    projectParams.projectId,
    activeSessionProjectExpanded,
    scrollRowIntoView,
  ]);

  // behavior session-page「键盘导航」: keep the cursor row on screen. The list is virtualised, so an
  // off-screen row has no DOM node — scrollIntoView cannot be used; the virtualizer must be asked
  // by index. Keyed on the cursor alone (never on `rows`) for the same reason the effect above is:
  // re-running on every sidebar mutation would yank the viewport around.
  const cursorKey = sessionKeyboardNav.cursor ? navNodeKey(sessionKeyboardNav.cursor) : null;
  useEffect(() => {
    const cursor = sessionKeyboardNav.cursor;
    if (!cursor || cursor.kind === 'new-session') return;
    const index = rowsRef.current.findIndex((row) =>
      cursor.kind === 'project'
        ? row.kind === 'project' && row.projectId === cursor.projectId
        : row.kind === 'conversation' && row.sessionId === cursor.sessionId
    );
    if (index >= 0) scrollRowIntoView(index);
  }, [cursorKey, scrollRowIntoView]);

  function setCurrentDragPointerY(pointerY: number | null) {
    dragPointerYRef.current = pointerY;
    setDragPointerY(pointerY);
  }

  function handleDragStart(event: DragStartEvent) {
    const pointerY = getEventClientY(event.activatorEvent);
    initialPointerYRef.current = pointerY;
    setActiveDragId(String(event.active.id));
    setCurrentDragPointerY(pointerY);
  }

  function handleDragMove(event: DragMoveEvent) {
    const initialPointerY = initialPointerYRef.current;
    if (initialPointerY === null) return;
    setCurrentDragPointerY(initialPointerY + event.delta.y);
  }

  function clearDragPointerY() {
    initialPointerYRef.current = null;
    setActiveDragId(null);
    setCurrentDragPointerY(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const pointerY = dragPointerYRef.current;
    clearDragPointerY();
    if (!over || active.id === over.id) return;
    const aParsed = parseDndId(String(active.id));
    // `over` may be any row (conversation/header/more sentinels included) — it only needs to
    // resolve to a list position below, not to a draggable entity.
    if (!aParsed) return;

    const isAbove = isCursorAbove(pointerY, active.rect.current.translated, over.rect);

    const overRowIdx = rows.findIndex((r) => rowToDndId(r) === String(over.id));
    if (overRowIdx === -1) return;
    const insertionRowIdx = isAbove ? overRowIdx : overRowIdx + 1;
    // 本机项目与别的机器上的项目(#6264)是同一张项目表,拖拽写回的是整份 id。
    const ids = sidebarStore.sidebarProjects
      .map((ref) => (ref.project.state === 'unregistered' ? ref.project.id : (ref.project.data?.id ?? '')))
      .filter(Boolean);
    const oldIdx = ids.indexOf(aParsed.projectId);
    if (oldIdx === -1) return;
    const projectsAbove = rows.slice(0, insertionRowIdx).filter((r) => r.kind === 'project').length;
    let newIdx = projectsAbove;
    if (newIdx > oldIdx) newIdx -= 1;
    if (newIdx === oldIdx) return;
    sidebarStore.setProjectOrder(arrayMove(ids, oldIdx, newIdx));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarCollision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      autoScroll={{ threshold: { x: 0, y: 0.18 }, acceleration: 8, interval: 5 }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={clearDragPointerY}
    >
      <SortableContext items={projectDndIds} strategy={verticalListSortingStrategy}>
        <div className={cn('pt-1 pb-1', sidebarGroupInsetX)}>
          <div
            ref={listRef}
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const row = rows[vItem.index];
              if (!row) return null;
              const vStyle: React.CSSProperties = {
                position: 'absolute',
                // vItem.start 是相对共用滚动容器的绝对位置,这里的定位原点却是本列表自己,
                // 所以要把 scrollMargin 减回去(TanStack Virtual 的 scrollMargin 用法)。
                top: vItem.start - scrollMargin,
                left: 0,
                width: '100%',
                height: row.kind === 'project' ? undefined : `${vItem.size}px`,
              };
              if (row.kind === 'project') {
                return (
                  <SortableRow key={row.projectId} dndId={rowToDndId(row)} style={vStyle} index={vItem.index} measure={virtualizer.measureElement}>
                    <SidebarProjectItem projectId={row.projectId} />
                    {sidebarStore.expandedProjectIds.has(row.projectId) && projectGroupsStore.chatIdOf(row.projectId) ? <ProjectTopicsSlot chatId={projectGroupsStore.chatIdOf(row.projectId)!} /> : null}
                  </SortableRow>
                );
              }
              if (row.kind === 'state-header') {
                return (
                  <div key={`${row.projectId}:state:${row.group}`} style={vStyle}>
                    <SidebarStateHeader group={row.group} count={row.count} variant="tree" />
                  </div>
                );
              }
              if (row.kind === 'conversation') {
                return (
                  <div key={`${row.projectId}:${row.sessionId}`} style={vStyle}>
                    <SidebarSessionItem
                      projectId={row.projectId}
                      sessionId={row.sessionId}
                      depth={row.depth}
                      parentProjectId={row.parentProjectId}
                      hasChildren={row.hasChildren}
                      expanded={sidebarStore.expandedSessionIds.has(row.sessionId)}
                      needsAttention={row.needsAttention}
                      onToggle={() => sidebarStore.toggleSessionExpanded(row.sessionId)}
                      join={row.join}
                    />
                  </div>
                );
              }
              return (
                <div key={`${row.projectId}:more`} style={vStyle}>
                  <SidebarMoreRow
                    foldKey={row.projectId}
                    expanded={row.expanded}
                    hiddenCount={row.hiddenCount}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeDragId ? <DragOverlayContent dndId={activeDragId} /> : null}
      </DragOverlay>
      <InsertionIndicator pointerY={dragPointerY} />
    </DndContext>
  );
});

const toProjectDndId = (id: string) => `proj::${id}`;

type SidebarDndId = { kind: 'project'; projectId: string };

function rowToDndId(row: SidebarRow): string {
  if (row.kind === 'project') return toProjectDndId(row.projectId);
  // State headers / conversation / more rows are not draggable/droppable; these ids only ever
  // serve as non-matching sentinels.
  if (row.kind === 'state-header') {
    return `state::${row.projectId}::${row.group}`;
  }
  if (row.kind === 'conversation') {
    return `conv::${row.projectId}::${row.sessionId}::${row.sessionId}`;
  }
  return `more::${row.projectId}`;
}

function parseDndId(id: string): SidebarDndId | null {
  if (id.startsWith('proj::')) return { kind: 'project', projectId: id.slice(6) };
  return null;
}

// Only projects drag; drags consider every visible row so dropping over a nested row maps to its
// owning project in onDragEnd without changing the virtualized list mid-drag.
const sidebarCollision: CollisionDetection = (args) => {
  const activeId = String(args.active.id);
  const parsed = parseDndId(activeId);
  if (!parsed) return [];
  const containers = args.droppableContainers.filter((c) => String(c.id) !== activeId);
  const filteredArgs = { ...args, droppableContainers: containers };
  const pointerCollisions = pointerWithin(filteredArgs);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(filteredArgs);
};

function getEventClientY(event: Event): number | null {
  if ('clientY' in event && typeof event.clientY === 'number') return event.clientY;
  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch?.clientY ?? null;
  }
  return null;
}

function isCursorAbove(
  pointerY: number | null,
  translated: ClientRect | null,
  overRect: ClientRect
): boolean {
  if (pointerY !== null) return pointerY < overRect.top + overRect.height / 2;
  if (!translated) return true;
  const cursorY = translated.top + translated.height / 2;
  const overCenterY = overRect.top + overRect.height / 2;
  return cursorY < overCenterY;
}

function DragOverlayContent({ dndId }: { dndId: string }) {
  const parsed = parseDndId(dndId);
  if (!parsed) return null;
  return (
    // 拖拽预览要和列表里那一行对齐,所以吃同一个留白出处。
    <div className={sidebarGroupInsetX}>
      <div className="rounded-lg bg-background-tertiary-2 shadow-lift">
        <SidebarProjectItem projectId={parsed.projectId} />
      </div>
    </div>
  );
}

function InsertionIndicator({ pointerY }: { pointerY: number | null }) {
  const { active, over } = useDndContext();
  if (!active || !over || active.id === over.id) return null;
  const activeParsed = parseDndId(String(active.id));
  if (!activeParsed) return null;
  const overRect = over.rect;
  if (!overRect) return null;
  const isAbove = isCursorAbove(pointerY, active.rect.current.translated, overRect);
  const top = isAbove ? overRect.top : overRect.top + overRect.height;
  return createPortal(
    <div
      className="bg-foreground"
      style={{
        position: 'fixed',
        left: overRect.left + 8,
        top: top - 1.5,
        width: Math.max(0, overRect.width - 16),
        height: 3,
        borderRadius: 2,
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    />,
    getPortalContainerOrBody()
  );
}

interface SortableRowProps {
  dndId: string;
  style: React.CSSProperties;
  children: React.ReactNode;
  index: number;
  measure: (element: HTMLDivElement | null) => void;
}

function SortableRow({ dndId, style, children, index, measure }: SortableRowProps) {
  const { setNodeRef, transform, transition, isDragging, listeners } = useSortable({
    id: dndId,
  });

  const ref = useCallback((element: HTMLDivElement | null) => {
    setNodeRef(element);
    measure(element);
  }, [setNodeRef, measure]);

  const combinedStyle: React.CSSProperties = {
    ...style,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 1 : 'auto',
  };

  return (
    <div ref={ref} data-index={index} style={combinedStyle} {...listeners}>
      {children}
    </div>
  );
}
