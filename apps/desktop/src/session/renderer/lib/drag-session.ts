/**
 * 把一条会话拖到别处:侧栏里的一行、或一块左上的 ⋮⋮(整个会话)。落在另一条会话的输入框(编程形态是终端)上 =
 * 一枚 @ 提及;落在一块的上下左右边 = 在那边分出一块放它(spec session-page「一屏几块」,落点由会话页这一屏判)。
 *
 * 形状照 `drag-files.ts` 的工作区文件拖拽来:自定义 MIME 当标记,真正的载荷同时走一个
 * 模块级变量(Electron/Chromium 在 drop 时会把自定义 MIME 的字符串弄丢,实测 `getData`
 * 返回空白)。拖源和落点同在一个渲染进程,所以这个变量够用;标记仍必须在 `DataTransfer`
 * 里,否则上一次拖拽的残留会被一个毫不相干的 drop 收走。
 *
 * ⚠️ 这里**不写** `text/plain`。composer 的输入框是 ProseMirror,它自己的 drop 处理会把
 * `text/plain` 当文本插进正文 —— 那样一次拖拽会同时得到一枚 pill 和一段裸文字。
 * 实测(headless Chromium)没有 `text/plain` 时 drop 照样触发、自定义 MIME 照样读得到。
 */

export const SESSION_DRAG_TYPE = 'application/x-gugu-session';

export type DraggedSession = {
  /** 被拖的那条会话。@ 提及要的身份(user:<uuid>)由落点按它去名册里查。 */
  sessionId: string;
  /** 侧栏上显示的标题,只用于落点的提示文案。 */
  title: string;
  /** 它所在的项目:落在一块的边上时,分出来的那块要知道开哪个会话页。 */
  projectId?: string;
};

let draggedSession: DraggedSession | null = null;

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

export function setDraggedSession(
  dataTransfer: DataTransfer,
  input: DraggedSession,
  sourceRow?: HTMLElement | null
): void {
  const payload: DraggedSession = {
    sessionId: input.sessionId,
    title: input.title,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
  draggedSession = payload;
  dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify(payload));
  // copy = 落成一枚 @;move = 分出一块(把这个会话挪过去)。
  dataTransfer.effectAllowed = 'copyMove';

  if (!sourceRow) return;
  const image = makeDragImage(sourceRow);
  // 指针咬在行首附近,拖的是「这一行」而不是「一张飘在旁边的图」。
  dataTransfer.setDragImage(image, 24, image.getBoundingClientRect().height / 2);
  // 快照是同步拍的,但要等浏览器**这一帧**画完才能拆台 —— 立即 remove 会拍到空白。
  requestAnimationFrame(() => image.remove());
}

/** 在 dragend 上调用;drop 先于源上的 dragend 触发,所以这时清是安全的。 */
export function clearDraggedSession(): void {
  draggedSession = null;
}

export function hasDraggedSession(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(SESSION_DRAG_TYPE);
}

function isDraggedSession(value: unknown): value is DraggedSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DraggedSession>;
  return typeof candidate.sessionId === 'string' && typeof candidate.title === 'string';
}

export function getDraggedSession(dataTransfer: DataTransfer): DraggedSession | null {
  if (!hasDraggedSession(dataTransfer)) return null;
  if (draggedSession) return draggedSession;

  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(SESSION_DRAG_TYPE));
    return isDraggedSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
