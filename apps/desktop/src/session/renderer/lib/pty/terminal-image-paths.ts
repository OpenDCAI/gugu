// Chromium hands out drag-temp paths under the OS temp tree (e.g.
// /var/folders/.../T/Drops/... on macOS). Those files are deleted right after
// drop/paste completes, before Claude/Codex can read them.
export function isUnstableDropPath(path: string): boolean {
  if (!path) return true;
  if (/^\/(?:private\/)?var\/folders\/.*\/T\/Drops\//.test(path)) return true;
  if (/[\\/](?:tmp|temp)[\\/]/i.test(path) && /(?:drop|chromium|electron)/i.test(path)) {
    return true;
  }
  if (/[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i.test(path)) return true;
  return false;
}

/** 别的 App 的私有目录:`~/Library/Containers/<id>/`、`~/Library/Group Containers/<id>/`。 */
const APP_CONTAINER = /\/Library\/(?:Group )?Containers\/([^/]+)\//;
/** 系统临时目录:macOS 的 `$TMPDIR` 在 `/var/folders` 下,还有 `/tmp`。 */
const TEMP_DIRECTORY = /^\/(?:private\/)?(?:var\/folders|tmp)\//;

/**
 * 这条原路径能不能留给 agent 之后去读(#985)。不能的,mention 改指咕咕自己存的那一份:
 * - 会消失的:拖放临时文件(`isUnstableDropPath`)和系统临时目录里别人放的文件;
 * - 读了会弹系统授权框的:别的 App 的私有目录。agent 是咕咕的子进程,macOS 把这次读算在咕咕头上,
 *   弹「访问其他 App 的数据」—— 回合就停在弹窗上,没人在屏幕前就一直停着。
 * 咕咕自己放的不算:自己的容器(`com.gugu.app*`)、自己写进临时目录的 `gugu-drop-*`。
 */
export function mustCopyRatherThanReference(path: string): boolean {
  if (isUnstableDropPath(path)) return true;
  const container = APP_CONTAINER.exec(path)?.[1];
  if (container) return !/(?:^|\.)com\.gugu\.app(?:\.|$)/.test(container);
  if (TEMP_DIRECTORY.test(path)) return !/\/gugu-drop-[^/]*$/.test(path);
  return false;
}

export function isClipboardImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return isHeicLikeFile(file);
}

export function isHeicLikeFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type.includes('heic') || type.includes('heif')) return true;
  return /\.(heic|heif)$/i.test(file.name);
}

export function extractClipboardImageFiles(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData?.items) return [];
  const imageFiles: File[] = [];
  const seen = new Set<string>();
  for (const item of clipboardData.items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file || !isClipboardImageFile(file)) continue;

    const fingerprint = `${file.name}\0${file.type}\0${file.size}\0${file.lastModified}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    imageFiles.push(file);
  }

  if (clipboardData.types.some((type) => type.toLowerCase().startsWith('image/'))) {
    // Browser ordering of clipboard items is not guaranteed, so pick a lossless,
    // widely-supported representation deterministically instead of trusting index 0.
    const preferredOrder = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    const rank = (type: string): number => {
      const index = preferredOrder.indexOf(type.toLowerCase());
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    imageFiles.sort((a, b) => rank(a.type) - rank(b.type));
    return imageFiles.slice(0, 1);
  }

  return imageFiles;
}

export function isNearDuplicatePaste(recentPasteAt: number, now = Date.now()): boolean {
  return recentPasteAt > 0 && now >= recentPasteAt && now - recentPasteAt < 250;
}

export function clipboardDataMayContainImage(clipboardData: DataTransfer | null): boolean {
  if (!clipboardData) return false;
  if (extractClipboardImageFiles(clipboardData).length > 0) return true;
  return clipboardData.types.some((type) => {
    const lower = type.toLowerCase();
    return lower.startsWith('image/') || lower.includes('heic') || lower.includes('heif');
  });
}

// POSIX backslash escaping keeps the path a single shell token without quote
// literals that break Claude Code image detection.
export function escapePathForTerminal(path: string): string {
  return path.replace(/([\s'"\\$`!*?()[\]{}|;<>&#~])/g, '\\$1');
}

export function escapeWindowsPathForTerminal(path: string): string {
  return `"${path.replace(/"/g, '""')}"`;
}

export function formatTerminalImagePaths(paths: string[], platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return paths.map(escapeWindowsPathForTerminal).join(' ');
  }
  return paths.map(escapePathForTerminal).join(' ');
}

export function wrapAsBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

export function buildTerminalImageInjection(paths: string[], platform: NodeJS.Platform): string {
  const formatted = formatTerminalImagePaths(paths, platform);
  return wrapAsBracketedPaste(formatted);
}
