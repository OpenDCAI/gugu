import type { IFileSystem } from '@gugu/session-core/files';
import { PROJECT_STATE_DIR_NAME } from './project-state-dir';
import { log } from '@main/lib/logger';

const GIT_EXCLUDE_PATH = '.git/info/exclude';
const IGNORE_PATTERN = `${PROJECT_STATE_DIR_NAME}/`;

function joinProjectPath(rootPath: string, relativePath: string): string {
  const separator = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/';
  return rootPath.endsWith('/') || rootPath.endsWith('\\')
    ? `${rootPath}${relativePath}`
    : `${rootPath}${separator}${relativePath}`;
}

/**
 * Ensure the project's `.gugu/` runtime dir is git-ignored via `.git/info/exclude`.
 *
 * The product keeps per-project state under `.gugu/` inside the repo: saved
 * attachments and uploaded images. None of that belongs in the user's tree, so we
 * exclude it locally rather than touching a tracked `.gitignore`.
 *
 * Best effort and idempotent: skips repos without a real `.git` directory (linked
 * worktrees / submodules use a `.git` file whose exclude is out of this fs's root) and
 * skips when `.gugu` is already ignored (e.g. via a global gitignore).
 *
 * 改名前建的仓里那行 `.emdash/` 保持原样 —— 那个目录还在,还得继续被忽略;
 * 这里只负责把新名字补上去。
 */
export async function ensureEmdashGitExcluded(fs: IFileSystem, repoPath: string): Promise<void> {
  const gitPath = joinProjectPath(repoPath, '.git');
  const excludePath = joinProjectPath(repoPath, GIT_EXCLUDE_PATH);

  const gitDir = await fs.stat(gitPath);
  if (!gitDir.success || gitDir.data.type !== 'directory') return;

  let existing = '';
  const excludeExists = await fs.exists(excludePath);
  if (excludeExists.success && excludeExists.data) {
    const read = await fs.readText(excludePath);
    if (!read.success) return;
    // `read` caps at a default byte limit; rewriting a truncated view would drop
    // any rules past the cut. Bail rather than risk corrupting the file.
    if (read.data.truncated) return;
    existing = read.data.content;
  }

  const alreadyExcluded = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === PROJECT_STATE_DIR_NAME || line === IGNORE_PATTERN);
  if (alreadyExcluded) return;

  const base = existing.replace(/\s*$/, '');
  const next = base.length > 0 ? `${base}\n${IGNORE_PATTERN}\n` : `${IGNORE_PATTERN}\n`;
  const result = await fs.writeText(excludePath, next);
  if (!result.success) {
    throw new Error(result.error.message);
  }
}

/** Fire-and-forget wrapper that never rejects; logs and moves on. */
export function ensureEmdashGitExcludedSafe(
  fs: IFileSystem,
  repoPath: string,
  projectId: string
): void {
  void ensureEmdashGitExcluded(fs, repoPath).catch((error) => {
    log.warn('ensureEmdashGitExcluded failed', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
