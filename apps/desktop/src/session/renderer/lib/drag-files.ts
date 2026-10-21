import type { MentionItem } from '@gugu/session-ui/react/components';
import { basenameFromAnyPath } from '@shared/path-name';

export function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files');
}

export function getDraggedFilePaths(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => electronApi().getPathForFile(file).trim())
    .filter(Boolean);
}

/**
 * 拖进输入框的**文件夹** → 正文里那条路径引用(pill)。
 * 文件夹没有可上传的字节,不进附件通道;agent 要的本就是这条路径。
 * 显示文件夹名,发给 agent 的写法(`@[名字](/绝对路径)`)与路径附件同一种语法。
 * 返回 null = 这件 File 带不出本地路径,没有可插的东西。
 */
export function droppedDirectoryMention(file: File): MentionItem | null {
  const path = electronApi().getPathForFile(file).trim();
  if (!path) return null;
  return {
    id: path,
    label: path,
    kind: 'file',
    name: basenameFromAnyPath(path) || path,
  };
}

/**
 * In-app drags of workspace files (e.g. from the editor file tree) are tagged
 * with this MIME type. Custom types must be lowercase; browsers lowercase
 * `DataTransfer.types`.
 */
export const WORKSPACE_FILE_DRAG_TYPE = 'application/x-emdash-workspace-file';

export type DraggedWorkspaceFile = {
  workspaceId: string;
  /** Absolute path in the workspace environment where the target agent runs. */
  targetPath: string;
  /** Remote workspaces are Linux targets even when the renderer runs elsewhere. */
  targetPlatform?: NodeJS.Platform;
};

type DraggedWorkspaceFileInput = {
  workspaceId: string;
  /** Absolute path in the workspace environment where the target agent runs. */
  targetPath: string;
  targetPlatform?: NodeJS.Platform;
};

// Electron/Chromium can mangle custom-MIME payloads on drop (getData returns
// whitespace), so the payload also travels through this module-level store —
// drag source and same-window drop targets share the renderer. Consumers still
// require the DataTransfer marker so stale state from a previous drag cannot be
// accepted by an unrelated drop.
let draggedWorkspaceFile: DraggedWorkspaceFile | null = null;

export function setDraggedWorkspaceFile(
  dataTransfer: DataTransfer,
  input: DraggedWorkspaceFileInput
): void {
  const payload: DraggedWorkspaceFile = {
    workspaceId: input.workspaceId,
    targetPath: input.targetPath,
    targetPlatform: input.targetPlatform,
  };

  draggedWorkspaceFile = payload;
  dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, JSON.stringify(payload));
  dataTransfer.setData('text/plain', payload.targetPath);
  dataTransfer.effectAllowed = 'copy';
}

/** Call on dragend; drop fires on the target before dragend on the source. */
export function clearDraggedWorkspaceFile(): void {
  draggedWorkspaceFile = null;
}

/** True when this transfer is tagged as an in-app workspace-file drag. */
import { electronApi } from './electron-api';
export function hasDraggedWorkspaceFile(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(WORKSPACE_FILE_DRAG_TYPE);
}

const NODE_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd',
]);

function isNodePlatform(value: unknown): value is NodeJS.Platform {
  return typeof value === 'string' && NODE_PLATFORMS.has(value as NodeJS.Platform);
}

function isDraggedWorkspaceFile(value: unknown): value is DraggedWorkspaceFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DraggedWorkspaceFile>;
  return (
    typeof candidate.workspaceId === 'string' &&
    typeof candidate.targetPath === 'string' &&
    (candidate.targetPlatform === undefined || isNodePlatform(candidate.targetPlatform))
  );
}

export function getDraggedWorkspaceFile(dataTransfer: DataTransfer): DraggedWorkspaceFile | null {
  if (!hasDraggedWorkspaceFile(dataTransfer)) return null;
  if (draggedWorkspaceFile) return draggedWorkspaceFile;

  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE));
    return isDraggedWorkspaceFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
