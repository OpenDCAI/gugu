import { useDraggable, useDroppable } from '@dnd-kit/core';
import { useRef } from 'react';
import { TabSlot } from './tab-chip';

export function DraggableTab({
  id,
  pairRole,
  children,
}: {
  id: string;
  /** 并排的一对里排左 / 排右:index.css 按它把两枚画成连着的一块(spec session-page「并排」)。 */
  pairRole?: 'start' | 'end';
  children: React.ReactNode;
}) {
  const data = useRef<{ tabReorderTarget?: string }>({});
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id, data: data.current });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id });

  return (
    // 位(宽度规矩 / 分隔线 / 耳朵的锚点)归 <TabSlot>,这里只往上面接拖拽 ——
    // ❌ 别把那几个数再抄一份:草稿工作区面板那条贴条不参与拖拽,但用的是同一个位。
    <TabSlot
      ref={(el) => {
        setDragRef(el);
        setDropRef(el);
      }}
      {...attributes}
      {...listeners}
      data-tab-pair={pairRole}
      data-tab-dragging={isDragging || undefined}
      style={{ opacity: isDragging ? 0 : undefined }}
    >
      {isOver && <DropIndicator />}
      {children}
    </TabSlot>
  );
}

function DropIndicator() {
  return <div className="pointer-events-none absolute inset-y-1 left-0 z-10 w-0.5 bg-foreground" />;
}

export function PaneDropZone({ paneId }: { paneId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `pane-drop-${paneId}` });
  return (
    <div ref={setNodeRef} className="relative h-full flex-1">
      {isOver && <DropIndicator />}
    </div>
  );
}
