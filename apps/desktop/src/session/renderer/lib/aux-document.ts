import { dispatchMatchingHotkeys } from '@renderer/lib/hotkeys/dispatch-matching-hotkeys';

/**
 * 一扇咕咕子窗口的文档要和主窗长得一样(app/aux-window-host.tsx):样式、主题、平台标记都从主窗抄过去,
 * 主窗之后再变(切深浅色、开发时样式热更新、按需加载的样式)也跟着变。界面本身由主窗那边的 React 画进来。
 */
export function mirrorDocument(from: Document, to: Document): () => void {
  // 观察的是主窗的节点,用主窗那边的 MutationObserver。
  const Observer = from.defaultView?.MutationObserver ?? MutationObserver;
  const copyAttributes = (source: Element, target: Element) => {
    for (const name of target.getAttributeNames()) if (!source.hasAttribute(name)) target.removeAttribute(name);
    for (const name of source.getAttributeNames()) target.setAttribute(name, source.getAttribute(name) ?? '');
  };
  const copyRootAttributes = () => copyAttributes(from.documentElement, to.documentElement);
  copyRootAttributes();
  const rootObserver = new Observer(copyRootAttributes);
  rootObserver.observe(from.documentElement, { attributes: true });

  // 样式按主窗 head 里的先后抄(后来的压前面的,皮肤那层必须在最后);抄过去的那份记着出处,好跟着删、跟着改。
  const clones = new Map<Node, Node>();
  const isSheet = (node: Node) =>
    node.nodeName === 'STYLE' || (node.nodeName === 'LINK' && (node as HTMLLinkElement).rel === 'stylesheet');
  const add = (node: Node) => {
    if (clones.has(node)) return;
    const clone = to.importNode(node, true);
    clones.set(node, clone);
    let next = node.nextSibling;
    while (next && !clones.has(next)) next = next.nextSibling;
    const before = next ? clones.get(next) : null;
    if (before && before.parentNode === to.head) to.head.insertBefore(clone, before);
    else to.head.appendChild(clone);
  };
  for (const node of from.head.childNodes) if (isSheet(node)) add(node);
  const sheetOf = (node: Node | null): Node | null => {
    for (let at = node; at; at = at.parentNode) if (at.parentNode === from.head) return isSheet(at) ? at : null;
    return null;
  };
  const headObserver = new Observer((records) => {
    for (const record of records) {
      if (record.target === from.head) {
        record.addedNodes.forEach((node) => isSheet(node) && add(node));
        record.removedNodes.forEach((node) => {
          const clone = clones.get(node);
          clones.delete(node);
          clone?.parentNode?.removeChild(clone);
        });
        continue;
      }
      // 一张样式表的内容变了(开发时热更新是原地改文字):整张重抄。
      const sheet = sheetOf(record.target);
      const clone = sheet ? clones.get(sheet) : undefined;
      if (sheet && clone) clone.textContent = sheet.textContent;
    }
  });
  headObserver.observe(from.head, { childList: true, subtree: true, characterData: true });

  return () => {
    rootObserver.disconnect();
    headObserver.disconnect();
  };
}

/** 正在往一个输入框里打字:不带 ⌘ / Ctrl / Alt 的快捷键让给它(同 @tanstack/hotkeys 的 ignoreInputs)。 */
function isTyping(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return typeof element?.closest === 'function' && element.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/**
 * 快捷键在子窗口里也照常用:子窗的按键到不了主窗文档上的那套监听(它们挂在主窗的 document 上,而且跨窗口的
 * `instanceof` 判断会失败),所以在子窗文档上接住、交给同一张快捷键登记表。登记表里谁此刻生效由各自的
 * `enabled` 决定 —— 子窗里的页签快捷键只在这扇窗有焦点时生效(app/screen-block-context)。
 */
export function bridgeHotkeys(doc: Document): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const typing = isTyping(event.target);
    dispatchMatchingHotkeys(event, {
      filter: (registration) => {
        const hotkey = registration.parsedHotkey;
        return !typing || hotkey.meta || hotkey.ctrl || hotkey.alt;
      },
    });
  };
  doc.addEventListener('keydown', onKeyDown);
  return () => doc.removeEventListener('keydown', onKeyDown);
}
