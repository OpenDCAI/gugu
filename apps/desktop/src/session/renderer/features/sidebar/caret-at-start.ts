/**
 * behavior session-page「键盘导航」: ← 只有在它于输入框里无事可做时才是出口。
 *
 * 「无事可做」= 光标已在最前且没有选中文字 —— 那个位置按 ← 本来就不动,拿它当出口不抢任何语义。
 * 单独成模块是为了能在真浏览器里量它:它只碰 DOM 的 Selection/Range,不碰应用状态,测试因此
 * 不必拖起半个 renderer。
 */

/**
 * 判据是「光标前没有内容」而不是「首行 offset 0」:输入框是一个 ProseMirror 文档、换行是 hardBreak
 * 节点,只看 offset 说不出行首在哪。open shadow root 要用它自己的 getSelection —— document 的只到
 * host 为止。
 */
export function caretAtStartOf(editor: HTMLElement): boolean {
  const root = editor.getRootNode() as Node & { getSelection?: () => Selection | null };
  const selection = root.getSelection?.() ?? document.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
  const caret = selection.getRangeAt(0);
  if (!editor.contains(caret.startContainer)) return false;
  const before = caret.cloneRange();
  before.selectNodeContents(editor);
  before.setEnd(caret.startContainer, caret.startOffset);
  if (before.toString().length > 0) return false;
  // 换行不是文字,所以「光标前没有文字」在「首行是空行」时照样成立 —— 那里的 ← 该上移一行,
  // 不该跳出输入框。两种空行都要挡:软换行是 <br>,而 plainTextDoc 把每一行摊成一个段落,
  // 空首行就是一个空 <p>。真正的文档开头只会切出一个「被切了一半的首块」。
  const before_ = before.cloneContents();
  return before_.querySelector('br') === null && before_.childNodes.length <= 1;
}
