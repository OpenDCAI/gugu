export function resolveWorkspacePath(workspacePath: string | undefined, filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (isAbsolutePath(normalizedPath) || !workspacePath) return normalizedPath;
  const root = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const relative = normalizedPath.replace(/^\/+/, '');
  return `${root}/${relative}`;
}

export function relativeToWorkspace(workspacePath: string, filePath: string): string {
  const root = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = filePath.replace(/\\/g, '/');
  const prefix = `${root}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

/** 路径判定的单一出处:聊天链接路由与它的契约测试都从这儿拿,❌ 各自复刻一份(两份今天
 * 一致,改一边就分岔)。反斜杠先归一 —— `C:\…` 与 `C:/…` 是同一种绝对路径。 */
export function isAbsolutePath(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath);
}

/**
 * 两种写法指的是不是同一个文件(文件页签据此去重)。斜杠先归一;带盘符或 UNC 的是 Windows 路径,不分大小写 ——
 * `C:\A\x.html` 与 `c:/a/X.html` 是同一个文件。看路径自己的写法而不看这台电脑:会话的文件可能在别的机器上。
 * POSIX 路径原样比:Linux 上大小写不同就是两个文件。
 */
export function filePathKey(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return /^([A-Za-z]:\/|\/\/)/.test(normalizedPath) ? normalizedPath.toLowerCase() : normalizedPath;
}

/** 路径的最后一段。`\` 也算分隔:以前存下的工作区外路径还是原样的 Windows 写法。 */
export function fileBaseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

export function isPathInsideWorkspace(workspacePath: string, filePath: string): boolean {
  const root = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = filePath.replace(/\\/g, '/');
  return path === root || path.startsWith(`${root}/`);
}
