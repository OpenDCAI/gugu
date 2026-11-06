/**
 * Esc 这一下是不是没人在用:焦点在输入框 / 终端 / 编辑器里,或者开着弹窗、菜单,都留给它们。
 * 主窗和 App 的客体页各判各自的文档(extension-bridge-preload),所以放在 shared。
 */
export function escapeIsFree(target: EventTarget | null): boolean {
  if (typeof document === 'undefined') return true;
  const el = target instanceof Element ? target : null;
  if (el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm, .cm-editor, [role="dialog"], [role="menu"]')) return false;
  const expanded = [...document.querySelectorAll('[aria-expanded="true"][aria-controls]')];
  return ![...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')].some((popup) => {
    // Page lists stay mounted; only an open popup (or its expanded control) owns page Escape.
    if (popup.getAttribute('role') === 'listbox' && !popup.hasAttribute('data-open') &&
        !expanded.some((control) => popup.id && control.getAttribute('aria-controls')?.split(/\s+/).includes(popup.id))) return false;
    for (let node: Element | null = popup; node; node = node.parentElement) {
      if (node.matches('[hidden], [inert], [aria-hidden="true"], [data-closed]')) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  });
}
