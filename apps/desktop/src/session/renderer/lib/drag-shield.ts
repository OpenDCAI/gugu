/**
 * 拖拽进行中(页签、左边一行、⋮⋮,#7052):内嵌网页(浏览器页签、App 的页、HTML 预览的 iframe)暂时不接指针。
 * 网页是另一个进程画的,指针一进去,宿主就再也收不到移动与放下 —— 落点画不出来,松手也没人接。
 * 只在拖的那一会儿;规则在 index.css 的 `html[data-gugu-dragging] :is(webview, iframe)`。
 */
export function setDragShield(on: boolean): void {
  const root = document.documentElement;
  if (on) root.setAttribute('data-gugu-dragging', '');
  else root.removeAttribute('data-gugu-dragging');
}

/**
 * 原生拖拽(左边一行、⋮⋮)的遮罩从开到关:`accepts` 认得的拖拽一起来就开;松手(drop)、拖完(dragend,含 Esc 与
 * 拖到窗口外)就关,`onEnd` 跟着收掉落点。返回卸下监听的函数。
 *
 * 源在拖的过程中可能被卸掉(侧栏的项目区是虚拟列表,拖到边上自动滚,那一行滚出去就没了):dragend 打在脱离了
 * 文档的源节点上,冒不到 document,document 上那一条收不到 —— 遮罩就一直开着,之后网页都点不进去。所以 dragstart
 * 时在源节点上直接再挂一条;两条都到也无妨,收两次是同一个结果。
 */
export function shieldNativeDrags(doc: Document, accepts: (dataTransfer: DataTransfer) => boolean, onEnd: () => void): () => void {
  const end = () => {
    setDragShield(false);
    onEnd();
  };
  const start = (event: DragEvent) => {
    if (!event.dataTransfer || !accepts(event.dataTransfer)) return;
    setDragShield(true);
    event.target?.addEventListener('dragend', end, { once: true });
  };
  doc.addEventListener('dragstart', start);
  doc.addEventListener('dragend', end, true);
  doc.addEventListener('drop', end, true);
  return () => {
    doc.removeEventListener('dragstart', start);
    doc.removeEventListener('dragend', end, true);
    doc.removeEventListener('drop', end, true);
  };
}
