export interface WorkspaceResourcePathArgs {
  /** Absolute workspace root. Resolution fails closed when this is missing. */
  workspacePath: string | undefined;
  /** Absolute path of the document that references the resource. */
  containingFilePath: string;
  /** The raw resource reference (src/href/url) from the document. */
  resourcePath: string;
}

/**
 * 把文档里的一个资源引用解析成本机路径。
 *
 * 两条分岔,取决于**承载文档自己在哪**(#5814):
 * - 文档在工作区里 —— 维持原样:相对路径按文档目录解析、`/` 开头按工作区根解析,
 *   且结果必须落在工作区内。那道闸圈的是 agent 写出来的页面能摸到什么。
 * - 文档在工作区外 —— 用户自己从磁盘上打开的文件。以文档所在目录为基准,
 *   并放行本机绝对路径。产品已经让这类文件可看可改可存(#5587),
 *   再拦住「把它引用的图显示出来」就只是把用户自己的文件挡在他自己眼前。
 *
 * 两条分岔都只认本机路径:`http(s):` / `data:` / `mailto:` / 协议相对地址一律返回 null,
 * 由调用方原样留给页面。`file:` 是本机路径的另一种写法,认。
 */
export function resolveWorkspaceResourcePath(args: WorkspaceResourcePathArgs): string | null {
  const { workspacePath, containingFilePath, resourcePath } = args;
  const trimmed = resourcePath.trim().replace(/\\/g, '/').split('#')[0]?.split('?')[0] ?? '';
  if (!trimmed) return null;

  // `file:` 指的就是本机上的一个文件,和 https:/data: 不是一类,别一起拒掉。
  const fromFileUrl = parseFileUrl(trimmed);
  const cleanSrc = fromFileUrl ?? trimmed;
  if (fromFileUrl === null && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  if (cleanSrc.startsWith('//') || cleanSrc.startsWith('#')) return null;

  // 工作区还没就位时一律解析失败 —— 这时判断不了文档在圈里还是圈外,不猜。
  if (!workspacePath) return null;

  const containing = splitAbsolutePath(containingFilePath);
  if (!containing) return null;

  const root = splitAbsolutePath(workspacePath.replace(/\/+$/, ''));
  if (!root) return null;

  // `file:` 写的永远是本机绝对路径,不是「工作区根相对」。
  const machineAbsolute = fromFileUrl !== null;

  if (isUnderRoot(containing, root)) {
    return resolveInsideWorkspace(cleanSrc, containing, root, machineAbsolute);
  }
  return resolveBesideDocument(cleanSrc, containing);
}

/** 承载文档在工作区里:原样的老行为,带工作区围栏。 */
function resolveInsideWorkspace(
  cleanSrc: string,
  containing: AbsoluteParts,
  root: AbsoluteParts,
  machineAbsolute: boolean
): string | null {
  if (machineAbsolute) {
    const absolute = splitAbsolutePath(cleanSrc);
    if (!absolute || absolute.prefix !== root.prefix) return null;
    const flattened = normalizeSegments([], absolute.segments);
    return flattened && isUnderRoot({ prefix: absolute.prefix, segments: flattened }, root)
      ? absolute.prefix + flattened.join('/')
      : null;
  }

  const baseSegments = cleanSrc.startsWith('/')
    ? root.segments.slice()
    : containing.segments.slice(0, -1);

  const normalized = normalizeSegments(baseSegments, cleanSrc.replace(/^\/+/, '').split('/'));
  if (!normalized) return null;

  if (normalized.length < root.segments.length) return null;
  for (let index = 0; index < root.segments.length; index += 1) {
    if (normalized[index] !== root.segments[index]) return null;
  }
  return root.prefix + normalized.join('/');
}

/**
 * 承载文档在工作区外:以它自己的目录为基准,绝对路径按本机路径原样解析。
 * 这里**没有**围栏 —— 围栏是给 agent 的,这条路上的文档是用户自己打开的。
 */
function resolveBesideDocument(cleanSrc: string, containing: AbsoluteParts): string | null {
  const absolute = splitAbsolutePath(cleanSrc);
  if (absolute) {
    const normalized = normalizeSegments([], absolute.segments);
    return normalized ? absolute.prefix + normalized.join('/') : null;
  }
  const normalized = normalizeSegments(containing.segments.slice(0, -1), cleanSrc.split('/'));
  return normalized ? containing.prefix + normalized.join('/') : null;
}

function normalizeSegments(baseSegments: string[], relSegments: string[]): string[] | null {
  const normalized: string[] = [];
  for (const segment of [...baseSegments, ...relSegments]) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (normalized.length === 0) return null;
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized;
}

/** 承载文档是不是落在工作区根里面。 */
function isUnderRoot(containing: AbsoluteParts, root: AbsoluteParts): boolean {
  if (containing.prefix !== root.prefix) return false;
  if (containing.segments.length < root.segments.length) return false;
  return root.segments.every((segment, index) => containing.segments[index] === segment);
}

/** 承载文档是否在工作区之外 —— 调用方据此决定走 readFile 还是 readExternalFile。 */
export function isOutsideWorkspace(
  workspacePath: string | undefined,
  filePath: string
): boolean {
  const containing = splitAbsolutePath(filePath);
  if (!containing) return false;
  const root = workspacePath ? splitAbsolutePath(workspacePath.replace(/\/+$/, '')) : null;
  // 判断不了就按「在圈里」处理,走那条更保守的读取路径。
  if (!root) return false;
  return !isUnderRoot(containing, root);
}

/**
 * `file:///Users/me/a.png` → `/Users/me/a.png`,`file:///C:/x/a.png` → `C:/x/a.png`。
 * 不是 file: URL 返回 null(调用方据此区分「不认识的协议」和「解析失败」)。
 */
function parseFileUrl(input: string): string | null {
  if (!/^file:/i.test(input)) return null;
  let rest = input.slice('file:'.length);
  // file://host/path 里的 host 只接受空和 localhost,其余(UNC 之类)不认。
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    const host = rest.slice(0, slash);
    if (host && host.toLowerCase() !== 'localhost') return null;
    rest = rest.slice(slash);
  }
  if (!rest.startsWith('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    decoded = rest;
  }
  // `/C:/x` 这种带盘符的,去掉前导斜杠还原成 `C:/x`。
  return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
}

type AbsoluteParts = { prefix: string; segments: string[] };

function splitAbsolutePath(input: string): AbsoluteParts | null {
  const normalized = input.replace(/\\/g, '/');
  const driveMatch = /^([A-Za-z]:)\//.exec(normalized);
  if (driveMatch) {
    const prefix = `${driveMatch[1]}/`;
    return { prefix, segments: normalized.slice(prefix.length).split('/').filter(Boolean) };
  }
  if (normalized.startsWith('/')) {
    return { prefix: '/', segments: normalized.slice(1).split('/').filter(Boolean) };
  }
  return null;
}
