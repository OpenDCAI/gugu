/**
 * 预览里的链接拦截。
 *
 * 预览跑在 `sandbox="allow-scripts"` 的 iframe 里 —— 没有 `allow-popups`,也没有
 * `allow-top-navigation`。所以页面里的 `<a>` 一旦交回浏览器默认导航,要么静默什么都不发生,
 * 要么把整个预览导走(#5814 / #6156)。凡是**要离开这个预览**的链接,都在这里拦下来
 * postMessage 给宿主,由宿主去开:相对链接交给标签页管理器开文件,`http(s)` 交给浏览器面板。
 *
 * ⚠️ **页内锚点(`#`)不拦,是故意的,而且只有现在才敢不拦。**
 * 预览改由 `gugu-preview://` 供给之后,文档有了自己的地址,`#x` 就是同文档跳转,浏览器自己
 * 滚过去。而在这之前预览走 `srcdoc` —— 那个文档没有地址,`#x` 会按宿主页的地址解析成一次
 * 跨文档导航,把 iframe 导到应用页上,整个预览变白(#6156)。同一行代码,在两种供给方式下
 * 一个是正确一个是故障:**判据不是「锚点该不该拦」,是「这份文档有没有自己的地址」。**
 *
 * 其余协议(`javascript:` / `mailto:` / `data:`)一概不碰 —— 不拦,也不假装能开。
 *
 * 两段脚本还顺带接**双指捏合缩放**(#6456):iframe 里的 wheel 只到得了 iframe 自己的文档,宿主
 * 接不到,所以只能在这里接。改的是文档的 CSS `zoom`(按比例重排,和浏览器的 Cmd± 一样),
 * 换算与上下限用 `pinch-zoom.ts` 同一套常量;普通双指滑动不带 ctrlKey,照常滚动。
 */

import { DOCUMENT_MAX_ZOOM, DOCUMENT_MIN_ZOOM, PINCH_ZOOM_SENSITIVITY } from './pinch-zoom';

export const PREVIEW_LINK_MESSAGE_TYPE = 'gugu-preview-link';

const PREVIEW_PINCH_ZOOM = `
  var pinchZoom = 1;
  document.addEventListener('wheel', function(e){
    if (!e.ctrlKey) return;
    e.preventDefault();
    pinchZoom = Math.min(${DOCUMENT_MAX_ZOOM}, Math.max(${DOCUMENT_MIN_ZOOM},
      pinchZoom * Math.exp(-e.deltaY * ${PINCH_ZOOM_SENSITIVITY})));
    document.documentElement.style.zoom = String(pinchZoom);
  }, { passive: false, capture: true });
`;

export const PREVIEW_LINK_SCRIPT = `
(function(){${PREVIEW_PINCH_ZOOM}
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href) return;
    if (href.charAt(0) === '#') return;
    var scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
    if (scheme && !/^https?$/i.test(scheme[1])) return;
    e.preventDefault();
    try { parent.postMessage({ type: ${JSON.stringify(PREVIEW_LINK_MESSAGE_TYPE)}, href: href }, '*'); } catch(_){}
  }, true);
  // 表单提交同理会把预览导走,一律拦下。
  document.addEventListener('submit', function(e){ e.preventDefault(); }, true);
})();
`;

/**
 * 给**没有地址**的那种预览用的脚本(聊天里的 HTML 附件:内容是一段字符串,盘上没有对应文件,
 * 所以它只能继续走 `srcdoc`)。
 *
 * 与上面那段的唯一差别是**锚点必须自己处理**:srcdoc 文档没有地址,`#x` 会按宿主页的地址
 * 解析成跨文档导航,把预览整个导走(#6156)。这里拦下来自己滚过去。
 *
 * ⇒ 两段脚本的分界不是「哪个界面」,是**这份文档有没有自己的地址**。有地址的交给浏览器,
 * 没地址的自己来。把这条写在这儿,是因为下一个人加第三处预览时要先回答的正是这个问题。
 */
export const SRCDOC_PREVIEW_LINK_SCRIPT = `
(function(){${PREVIEW_PINCH_ZOOM}
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href) return;
    if (href.charAt(0) === '#') {
      // 没有地址,锚点只能自己滚 —— 交回默认导航就是白屏。
      e.preventDefault();
      var id = href.slice(1);
      if (!id) { window.scrollTo({ top: 0 }); return; }
      var el = null;
      try { el = document.getElementById(decodeURIComponent(id)); } catch (_) {}
      if (!el) el = document.getElementById(id);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
      return;
    }
    var scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
    e.preventDefault();
    // 只把 http(s) 递出去。其余协议不碰,也不假装能开 —— 但导航一律拦下:
    // 这个文档没有地址,任何一次导航都会把预览换成别的东西。
    if (scheme && !/^https?$/i.test(scheme[1])) return;
    try { parent.postMessage({ type: ${JSON.stringify(PREVIEW_LINK_MESSAGE_TYPE)}, href: href }, '*'); } catch(_){}
  }, true);
  document.addEventListener('submit', function(e){ e.preventDefault(); }, true);
})();
`;

/**
 * 判断一个 href 该不该交给浏览器面板。
 * 协议相对地址(`//example.com/x`)按 https 处理;其余返回 null,由调用方当本机路径解析。
 */
export function toExternalUrl(href: string): string | null {
  if (href.startsWith('//')) return `https:${href}`;
  return /^https?:\/\//i.test(href) ? href : null;
}
