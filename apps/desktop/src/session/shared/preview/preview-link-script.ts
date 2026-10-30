/**
 * 预览里的链接拦截。
 *
 * 预览跑在 `sandbox="allow-scripts"` 的 iframe 里 —— 没有 `allow-popups`,也没有
 * `allow-top-navigation`。所以页面里的 `<a>` 一旦交回浏览器默认导航,要么静默什么都不发生,
 * 要么把整个预览导走(#5814 / #6156)。凡是**要离开这个预览**的链接,都在这里拦下来
 * postMessage 给宿主,由宿主去开:相对链接交给标签页管理器开文件,`http(s)` 交给浏览器面板。
 *
 * 页内锚点复用原 srcdoc 脚本的定位分支。没有 allow-same-origin 的 Blob 预览会拒绝
 * 原生片段导航(Not allowed to load local resource: blob:…#target),因此两种传输都直接
 * 定位文档内的目标,保持同一个脚本和 sandbox,不改变导航权限。
 *
 * 其余协议(`javascript:` / `mailto:` / `data:`)一概不碰 —— 不拦,也不假装能开。
 *
 * 链接脚本还顺带接**双指捏合缩放**(#6456):iframe 里的 wheel 只到得了 iframe 自己的文档,宿主
 * 接不到,所以只能在这里接。改的是文档的 CSS `zoom`(按比例重排,和浏览器的 Cmd± 一样),
 * 换算与上下限用 `pinch-zoom.ts` 同一套常量;普通双指滑动不带 ctrlKey,照常滚动。
 */

import { DOCUMENT_MAX_ZOOM, DOCUMENT_MIN_ZOOM, PINCH_ZOOM_SENSITIVITY } from './pinch-zoom';

export const PREVIEW_LINK_MESSAGE_TYPE = 'gugu-preview-link';
export const PREVIEW_SCROLL_MESSAGE_TYPE = 'gugu-preview-scroll';
export const PREVIEW_RESTORE_MESSAGE_TYPE = 'gugu-preview-restore-scroll';
export const PREVIEW_RESTORED_MESSAGE_TYPE = 'gugu-preview-restored';

const PREVIEW_SCROLL_SCRIPT = `
  var scrollPending = false;
  window.addEventListener('scroll', function(){
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(function(){
      scrollPending = false;
      parent.postMessage({ type: '${PREVIEW_SCROLL_MESSAGE_TYPE}', x: window.scrollX, y: window.scrollY }, '*');
    });
  }, { passive: true });
  window.addEventListener('message', function(e){
    var data = e.data;
    if (e.source !== parent || !data || data.type !== '${PREVIEW_RESTORE_MESSAGE_TYPE}') return;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
    window.scrollTo({ left: Math.max(0, data.x), top: Math.max(0, data.y), behavior: 'instant' });
    requestAnimationFrame(function(){
      parent.postMessage({ type: '${PREVIEW_RESTORED_MESSAGE_TYPE}' }, '*');
    });
  });
`;

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
(function(){${PREVIEW_PINCH_ZOOM}${PREVIEW_SCROLL_SCRIPT}
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href) return;
    if (href.charAt(0) === '#') {
      // 复用原 srcdoc 分支:opaque sandbox 下的 Blob 也不能交回默认导航。
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
    if (scheme && !/^https?$/i.test(scheme[1])) return;
    e.preventDefault();
    try { parent.postMessage({ type: ${JSON.stringify(PREVIEW_LINK_MESSAGE_TYPE)}, href: href }, '*'); } catch(_){}
  }, true);
  // 表单提交同理会把预览导走,一律拦下。
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

/** 群正文没有目录授权:只允许内嵌及 HTTPS 资源,不能借本地协议读取宿主文件。 */
export const DOCUMENT_PREVIEW_CSP = [
  "default-src data: blob: https: 'unsafe-inline' 'unsafe-eval'",
  "connect-src https: wss:",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** 正文和同一份链接/捏合脚本。纯正文的策略放在内容前,Blob 也有同样的边界。 */
export function previewDocumentHtml(html: string, documentOnly = false): string {
  const policy = documentOnly
    ? '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + DOCUMENT_PREVIEW_CSP + '">'
    : '';
  return policy + html + '\n<script>' + PREVIEW_LINK_SCRIPT + '</script>';
}
