/**
 * #6264 别的机器上的会话做出来的网页,在这台桌面的「浏览器」页签里**渲染**出来(不是当源码看)。
 *
 * 本机的做法:agent 调 `session_open_in_tab` 给 `file:///…/x.html`,浏览器页签直接加载本机文件。
 * 别的机器上的文件这台电脑加载不到 —— 所以页签实际加载的是 `gugu-preview://<id>/x.html`:
 * 与本机「文件」页签的 HTML 预览**同一个协议、同一道围栏**(preview-url.ts),字节经会话工作区那条
 * 既有的读文件动词从那台机器上取(SSH 直连优先、云端兜底;路径关在会话目录里由那台机器核)。
 * 相对资源(css / js / 图片)因此按浏览器自己的 URL 解析就对,不必内联。
 *
 * 地址栏要诚实:人看到的是他(或 agent)要开的那个 `file:///…`,❌ 一串内部协议地址。
 * 这里只做两件纯计算:`file:` 地址 → 页签要加载的地址;页签报上来的地址 → 地址栏该显示的地址。
 *
 * ⚠️ 这个文件要能进浏览器与主进程两边:❌ import 任何带 node / electron 依赖的模块。
 */
import { PREVIEW_SCHEME, previewUrl, resolvePreviewRequest, splitAbsolutePath, type PreviewRoot } from './preview-url';

/**
 * `file:` 地址 → 那台机器上的绝对路径。不是 `file:`、带了别的主机(`file://host/x`)、路径不是绝对的 ⇒ null。
 * 查询串与锚点不算路径的一部分(页面自己用)。
 */
export function fileUrlToMachinePath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  if (parsed.hostname && parsed.hostname !== 'localhost') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  // Windows 形状 `/C:/x` → `C:/x`;POSIX 原样。
  const path = /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  const parts = splitAbsolutePath(path);
  if (!parts) return null;
  return parts.prefix + parts.segments.join('/');
}

/** 绝对路径 → `file:` 地址(每段按 URL 编码;盘符原样)。 */
export function machinePathToFileUrl(path: string): string | null {
  const parts = splitAbsolutePath(path);
  if (!parts) return null;
  const encoded = parts.segments.map(encodeURIComponent).join('/');
  const drive = parts.prefix === '/' ? '' : parts.prefix;
  return `file:///${drive}${encoded}`;
}

/** 会话工作目录当围栏(预览那道围栏的「圈内」一支)。不是绝对路径 ⇒ null。 */
export function remotePageRoot(root: string): PreviewRoot | null {
  const parts = splitAbsolutePath(root.replace(/[\\/]+$/, '') || '/');
  return parts ? { kind: 'workspace', prefix: parts.prefix, segments: parts.segments } : null;
}

function suffixOf(url: URL): string {
  return `${url.search}${url.hash}`;
}

/**
 * 页签要加载的地址:`file:///root/a/x.html?q#h` → `gugu-preview://<id>/a/x.html?q#h`。
 * 不是 `file:` / 不在会话工作目录里 ⇒ null(调用方如实说「只能打开工作目录里的网页」)。
 */
export function remotePageLoadUrl(previewId: string, root: string, fileUrl: string): string | null {
  const path = fileUrlToMachinePath(fileUrl);
  const fence = remotePageRoot(root);
  if (!path || !fence) return null;
  const base = previewUrl(previewId, fence, path);
  if (!base) return null;
  return `${base}${suffixOf(new URL(fileUrl))}`;
}

/**
 * 地址栏该显示的地址:页签报上来的是这一格自己的 `gugu-preview://<id>/…` ⇒ 换回 `file:///root/…`;
 * 别的地址(人点了外链、别的预览)⇒ null,原样显示。
 */
export function remotePagePresentUrl(previewId: string, root: string, loadedUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(loadedUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PREVIEW_SCHEME}:` || parsed.hostname !== previewId) return null;
  const fence = remotePageRoot(root);
  if (!fence) return null;
  const path = resolvePreviewRequest(fence, parsed.pathname);
  if (!path) return null;
  const fileUrl = machinePathToFileUrl(path);
  return fileUrl ? `${fileUrl}${suffixOf(parsed)}` : null;
}
