import { useState, type DragEvent } from 'react';
import { getDraggedSession } from '@renderer/lib/drag-session';

/** 被拖的那条会话(左边一行、⋮⋮),项目一定在:挂父会话要在它所在的机器上做。 */
export type DraggedSessionRef = { projectId: string; sessionId: string; title: string };

/**
 * 侧栏里接一条拖来的会话的那一行:会话行(挂到它下面)、项目行与「任务」分区头(回到根)。
 * `over` = 正拖在这一行上、而且这一行收它 —— 行上罩落点那一层(sidebarDropTargetClass)。
 * 收不收由调用点的 `accepts` 说,❌ 收不了的也亮;dragover 不 preventDefault,浏览器就不给松手。
 */
export function useSessionDropTarget() {
  const [over, setOver] = useState(false);
  const bind = (accepts: (dragged: DraggedSessionRef) => boolean, onDrop: (dragged: DraggedSessionRef) => void) => {
    const taken = (event: DragEvent<HTMLElement>): DraggedSessionRef | null => {
      const dragged = getDraggedSession(event.dataTransfer);
      if (!dragged?.projectId) return null;
      const ref = { projectId: dragged.projectId, sessionId: dragged.sessionId, title: dragged.title };
      return accepts(ref) ? ref : null;
    };
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!taken(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        setOver(false);
        const dragged = taken(event);
        if (!dragged) return;
        event.preventDefault();
        onDrop(dragged);
      },
    };
  };
  return { over, bind };
}
