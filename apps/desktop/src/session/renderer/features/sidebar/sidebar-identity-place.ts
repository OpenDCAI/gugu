/**
 * 身份卡上「设备」「文件夹」两行的值(owner 2026-10-28:一眼看出这条会话跑在哪台机器、哪个目录)。纯函数,卡与单测共用。
 *
 * 文件夹取会话自己的工作区(worktree / 它真正跑的那个目录),还没挂上就退到项目目录;两样都没有 ⇒ null(卡上写「未知」)。
 * 卡上显示把主目录缩成 `~`,复制出去的是完整绝对路径 —— 粘到终端里能直接 cd。
 */
export type IdentityPlace = {
  device: string;
  /** 完整路径(复制用);null = 不知道。 */
  folder: string | null;
  /** 卡上显示的那一份:主目录缩成 `~`。 */
  folderDisplay: string | null;
};

export function shortenHome(path: string, home: string | null): string {
  if (!home) return path;
  const base = home.replace(/[\\/]+$/, '');
  if (!base) return path;
  if (path === base) return '~';
  const next = path.charAt(base.length);
  if (path.startsWith(base) && (next === '/' || next === '\\')) return `~${path.slice(base.length)}`;
  return path;
}

export function identityPlace(input: {
  deviceLabel: string;
  workspacePath: string | null | undefined;
  projectPath: string | null | undefined;
  home: string | null;
}): IdentityPlace {
  const folder = input.workspacePath || input.projectPath || null;
  return { device: input.deviceLabel, folder, folderDisplay: folder === null ? null : shortenHome(folder, input.home) };
}
