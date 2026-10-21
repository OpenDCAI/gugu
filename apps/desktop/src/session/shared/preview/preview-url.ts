/**
 * 网页预览的地址与围栏。
 *
 * 预览以前走 `srcdoc`:文档**没有自己的地址**,于是页面里的每一个 URL 都按宿主页的地址解析
 * —— 相对资源找不到(所以有过 300 行手工内联),页内锚点变成一次跨文档导航把 iframe 整个导走
 * (#6156 的白屏)。现在预览由 `gugu-preview://` 供给,文档有了真地址,相对路径、锚点、
 * `srcset`、CSS 里的 `url(...)`、音视频、`@import` 全部回到浏览器自己手里。
 *
 * 这一模块只做两件纯计算的事:**给一份文档算出它的预览地址**,以及**把一个预览请求的路径
 * 还原成本机路径、同时判定它在不在围栏里**。读字节归主进程,拦外链归渲染层。
 *
 * 围栏沿用 `workspace-resource-path.ts` 定下的那条分岔(#5814),一个字都没改:
 * - **文档在工作区里** —— 围栏是工作区根。相对路径按文档目录算、`/` 开头按工作区根算,
 *   结果必须落在工作区内。那道闸圈的是 agent 写出来的页面能摸到什么。
 * - **文档在工作区外** —— 用户自己从磁盘上打开的文件,放行本机绝对路径。产品已经让这类
 *   文件可看可改可存(#5587),再拦住「把它引用的图显示出来」只是把用户自己的文件挡在他
 *   自己眼前。
 *
 * 换成 URL 之后这条分岔是**免费**得到的,不必再各写一套解析:把围栏当成 URL 的根,
 * 浏览器自己就会把 `../` 归一化、把 `/x` 指到根上 —— 这正是「让平台干平台的活」。
 */

export const PREVIEW_SCHEME = 'gugu-preview';

/**
 * 注册给 `registerSchemesAsPrivileged` 的那一条。**住在这个零依赖模块里是有原因的**:
 * 宿主 `main.ts` 必须在 `app ready` 之前注册 scheme,而它一旦在顶层 import 会话页主进程那边
 * 的模块,整张图就被提升到 `app.setPath` 之前(见 main.ts 里那条注释)。所以描述放这儿、
 * handler 留在会话页那边 boot 时装 —— 与 `EXTENSION_SCHEME` 同一个办法。
 */
export function previewSchemePrivilege() {
  return {
    scheme: PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // 视频要按字节范围取才能拖进度条;没有它,预览里的 <video> 只能从头播。
      stream: true,
    },
  } as const;
}

/** 预览的围栏。文档在工作区里就以工作区根为根,在圈外则放行本机绝对路径。 */
export type PreviewRoot =
  | { kind: 'workspace'; prefix: string; segments: string[] }
  | { kind: 'machine' };

type AbsoluteParts = { prefix: string; segments: string[] };

/**
 * `/Users/me/a.html` → `{ prefix: '/', segments: ['Users','me','a.html'] }`
 * `C:\x\a.html`      → `{ prefix: 'C:/', segments: ['x','a.html'] }`
 * 不是绝对路径返回 null。
 */
export function splitAbsolutePath(input: string): AbsoluteParts | null {
  const normalized = input.replace(/\\/g, '/');
  const driveMatch = /^([A-Za-z]:)\//.exec(normalized);
  if (driveMatch?.[1]) {
    const prefix = `${driveMatch[1]}/`;
    return { prefix, segments: normalized.slice(prefix.length).split('/').filter(Boolean) };
  }
  if (normalized.startsWith('/')) {
    return { prefix: '/', segments: normalized.slice(1).split('/').filter(Boolean) };
  }
  return null;
}

function joinParts(parts: AbsoluteParts): string {
  return parts.prefix + parts.segments.join('/');
}

function isUnder(child: AbsoluteParts, root: AbsoluteParts): boolean {
  if (child.prefix !== root.prefix) return false;
  if (child.segments.length < root.segments.length) return false;
  return root.segments.every((segment, index) => child.segments[index] === segment);
}

/**
 * 这份文档该用哪种围栏。
 *
 * ⚠️ 工作区还没就位时按「圈外」处理是**故意的**:这时判断不了文档在圈里还是圈外,而按圈里
 * 处理会得到一个以 `undefined` 为根的围栏,把用户自己打开的文件连同它引用的资源一起挡掉
 * —— 那正是 #5814 修过的那种「把用户自己的文件挡在他自己眼前」。
 */
export function previewRootFor(
  workspacePath: string | undefined,
  documentPath: string
): PreviewRoot {
  const doc = splitAbsolutePath(documentPath);
  const root = workspacePath ? splitAbsolutePath(workspacePath.replace(/\/+$/, '')) : null;
  if (!doc || !root) return { kind: 'machine' };
  return isUnder(doc, root) ? { kind: 'workspace', prefix: root.prefix, segments: root.segments } : { kind: 'machine' };
}

/**
 * 文档在预览地址里的那一段路径(URL 的 pathname)。
 *
 * 圈内取相对工作区根的那一段;圈外把整条本机绝对路径放进 pathname —— Windows 的盘符也留在
 * 里面(`/C:/x/a.html`),否则跨盘引用会丢(圈外本来就允许跨盘,见 `resolveBesideDocument`)。
 */
export function previewPathname(root: PreviewRoot, documentPath: string): string | null {
  const doc = splitAbsolutePath(documentPath);
  if (!doc) return null;
  if (root.kind === 'machine') {
    return '/' + (doc.prefix === '/' ? '' : doc.prefix) + doc.segments.join('/');
  }
  if (!isUnder(doc, { prefix: root.prefix, segments: root.segments })) return null;
  return '/' + doc.segments.slice(root.segments.length).join('/');
}

/** 一份文档的预览地址。`previewId` 是主进程发的一次性 id,同时也是这个页面的 origin。 */
export function previewUrl(previewId: string, root: PreviewRoot, documentPath: string): string | null {
  const pathname = previewPathname(root, documentPath);
  if (pathname === null) return null;
  const encoded = pathname.split('/').map(encodeURIComponent).join('/');
  return `${PREVIEW_SCHEME}://${previewId}${encoded}`;
}

/**
 * 把一个预览请求的 pathname 还原成本机路径,并判定它在不在围栏里。
 *
 * 越界返回 null —— 调用方据此答 403,❌ 不要退回去读一个「差不多」的路径。
 * `..` 在标准 scheme 下已被 URL 层归一化掉,这里再判一次是因为**围栏不能只有一道**:
 * 归一化是 Chromium 的实现细节,围栏是我们的承诺。
 */
export function resolvePreviewRequest(root: PreviewRoot, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const rest = decoded.replace(/^\/+/, '');

  if (root.kind === 'machine') {
    const absolute = /^[A-Za-z]:\//.test(rest) ? rest : '/' + rest;
    const parts = splitAbsolutePath(absolute);
    if (!parts) return null;
    const flattened = flatten([], parts.segments);
    return flattened ? joinParts({ prefix: parts.prefix, segments: flattened }) : null;
  }

  const flattened = flatten(root.segments, rest.split('/'));
  if (!flattened) return null;
  const resolved = { prefix: root.prefix, segments: flattened };
  return isUnder(resolved, { prefix: root.prefix, segments: root.segments })
    ? joinParts(resolved)
    : null;
}

function flatten(baseSegments: string[], relSegments: string[]): string[] | null {
  const out: string[] = [];
  for (const segment of [...baseSegments, ...relSegments]) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}
