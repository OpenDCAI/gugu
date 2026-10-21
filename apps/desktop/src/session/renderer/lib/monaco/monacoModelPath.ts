/**
 * Root for files that live outside every workspace.
 *
 * A workspace file is addressed by「工作区 + 相对路径」(`workspace:<id>` as the root) —
 * the same coordinates the draft store keys on. A file outside every workspace has no
 * such coordinate, which is why it used to get no model at all and every preview had to
 * carry its own「问 tab 还是问 Monaco」branch (#5585). Giving it a root of its own puts it
 * in the same address space instead of a second, parallel code path.
 */
export const EXTERNAL_MODEL_ROOT = 'external:';

export function isExternalModelRoot(rootPath: string): boolean {
  return rootPath === EXTERNAL_MODEL_ROOT;
}

/**
 * Workspace files are addressed by a relative path, files outside every workspace by an
 * absolute one — the same discriminator the main process uses to split readFile from
 * readExternalFile. Used when only a bare path survives (e.g. a restored draft row).
 */
export function isAbsoluteFilePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
}

/**
 * Build a stable Monaco model URI for a file within a project/worktree context.
 * Monaco uses this identity to keep model-local undo/redo history.
 */
export function buildMonacoModelPath(rootPath: string, filePath: string): string {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/g, '');
  const normalizedFile = filePath.replace(/\\/g, '/').replace(/^\/+/g, '');
  const joined = `${normalizedRoot}/${normalizedFile}`.replace(/\/{2,}/g, '/');
  const absolute = joined.startsWith('/') ? joined : `/${joined}`;
  const encodedPath = absolute
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `file://${encodedPath}`;
}
