/**
 * 终端是不是被一个**模态**挡在后面 —— 是则终端让出键盘。
 *
 * 只认模态的两种标准(ARIA)信号:
 *  · 终端被藏进了 `aria-hidden="true"` 的子树 —— base-ui 的 Dialog(`lib/ui/dialog`)打开时就是这样
 *    把模态之外的一切藏起来的,它不写 `aria-modal`;
 *  · 页面上有一个声明了 `aria-modal="true"` 的对话框,而终端不在它里面(Sheet、图片预览这类自绘模态)。
 *
 * ❌ 不认「页面上有任何 `role="dialog"`」:侧栏的会话身份卡、成员气泡这类**非模态**浮层也是
 * `role="dialog"`,它们在场时焦点仍在终端里,这时拦下按键就是吞键(#6378:右键「分叉」之后鼠标停在
 * 侧栏,身份卡悬停弹出,分叉出的终端头三个键全被丢掉,直到第一个 Esc 把卡片关掉)。
 */
export function terminalIsBehindModal(container: Element | null): boolean {
  if (!container) return false;
  if (container.closest('[aria-hidden="true"]')) return true;
  const modal = container.ownerDocument.querySelector(
    '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
  );
  return modal !== null && !modal.contains(container);
}
