import type { ScreenBlockContent } from '@renderer/app/screen-layout';

/** One workspace identity for sidebar rows and block grips. Never write text/plain: ProseMirror
 * would insert it beside a task mention. Chromium can lose custom MIME data at drop, so keep
 * the same-window payload until dragend; the MIME marker still guards against stale drags. */
export const SCREEN_CONTENT_DRAG_TYPE = 'application/x-gugu-screen-content';
export type DraggedScreenContent = ScreenBlockContent & { title: string };
let draggedContent: DraggedScreenContent | null = null;

/**
 * 拖起来的那张图 = 这一行**静止时**的样子。
 *
 * 不给的话浏览器直接拍**活着的那个元素**,而拖拽必然从「指针停在这一行」开始 —— 于是行尾
 * 那层只在 hover 时显形的置顶/归档钮(以及让位给它的时间)被一起拍进去,跟着指针满屏跑
 * (owner 2026-09-16 圈的就是这个)。拿一份副本去拍:副本没有指针停在上面,hover 态自然不成立,
 * 再把那层显式摘掉,省得日后有人把它改成常驻。
 */
function makeDragImage(row: HTMLElement): HTMLElement {
  const clone = row.cloneNode(true) as HTMLElement;
  for (const node of clone.querySelectorAll('[data-row-hover-actions]')) node.remove();
  const rect = row.getBoundingClientRect();
  Object.assign(clone.style, {
    position: 'fixed',
    top: '-10000px',
    left: '-10000px',
    width: `${rect.width}px`,
    pointerEvents: 'none',
  });
  document.body.appendChild(clone);
  return clone;
}

export function setDraggedScreenContent(
  dataTransfer: DataTransfer,
  input: DraggedScreenContent,
  sourceRow?: HTMLElement | null
): void {
  draggedContent = input;
  dataTransfer.setData(SCREEN_CONTENT_DRAG_TYPE, JSON.stringify(input));
  // copy = 落成一枚 @;move = 分出一块(把这个会话挪过去)。
  dataTransfer.effectAllowed = input.kind === 'session' ? 'copyMove' : 'move';

  if (!sourceRow) return;
  const image = makeDragImage(sourceRow);
  // 指针咬在行首附近,拖的是「这一行」而不是「一张飘在旁边的图」。
  dataTransfer.setDragImage(image, 24, image.getBoundingClientRect().height / 2);
  // 快照是同步拍的,但要等浏览器**这一帧**画完才能拆台 —— 立即 remove 会拍到空白。
  requestAnimationFrame(() => image.remove());
}

/** 在 dragend 上调用;drop 先于源上的 dragend 触发,所以这时清是安全的。 */
export function clearDraggedScreenContent(): void {
  draggedContent = null;
}

export function hasDraggedScreenContent(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(SCREEN_CONTENT_DRAG_TYPE);
}

function isDraggedContent(value: unknown): value is DraggedScreenContent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DraggedScreenContent>;
  if (typeof candidate.title !== 'string') return false;
  switch (candidate.kind) {
    case 'session': return typeof candidate.sessionId === 'string' && typeof candidate.projectId === 'string';
    case 'app': return typeof candidate.tabKind === 'string';
    case 'project': return typeof candidate.projectId === 'string';
    case 'chat': return typeof candidate.chatId === 'string';
    default: return false;
  }
}

export function getDraggedScreenContent(dataTransfer: DataTransfer): DraggedScreenContent | null {
  if (!hasDraggedScreenContent(dataTransfer)) return null;
  if (draggedContent) return draggedContent;

  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(SCREEN_CONTENT_DRAG_TYPE));
    return isDraggedContent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
