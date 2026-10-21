import type { IFileSystem } from '@gugu/session-core/files';
import { describe, expect, it, vi } from 'vitest';
import { ensureEmdashGitExcluded } from './ensure-emdash-excluded';

function statResult(path: string, type: 'file' | 'directory') {
  return {
    success: true as const,
    data: {
      path,
      type,
      size: 0,
      mtime: new Date(0),
      ctime: new Date(0),
      mode: type === 'directory' ? 0o040755 : 0o100644,
    },
  };
}

function notFound(path: string) {
  return {
    success: false as const,
    error: {
      type: 'fs-error' as const,
      path,
      message: `Not found: ${path}`,
      code: 'ENOENT',
    },
  };
}

function makeFs(opts: {
  gitType?: 'directory' | 'file';
  excludeContent?: string | null;
  truncated?: boolean;
}) {
  const writeText = vi.fn(async () => ({
    success: true as const,
    data: { bytesWritten: 1 },
  }));
  const fs = {
    stat: vi.fn(async (p: string) =>
      p === '/repo/.git' && opts.gitType ? statResult(p, opts.gitType) : notFound(p)
    ),
    exists: vi.fn(async () => ({
      success: true as const,
      data: opts.excludeContent != null,
    })),
    readText: vi.fn(async () => ({
      success: true as const,
      data: {
        content: opts.excludeContent ?? '',
        truncated: opts.truncated ?? false,
        totalSize: 0,
      },
    })),
    writeText,
  } as unknown as IFileSystem;
  return { fs, writeText };
}

describe('ensureEmdashGitExcluded', () => {
  it('skips repos without a real .git directory (linked worktree / submodule)', async () => {
    const { fs, writeText } = makeFs({ gitType: 'file', excludeContent: '' });
    await ensureEmdashGitExcluded(fs, '/repo');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('skips when there is no .git at all', async () => {
    const { fs, writeText } = makeFs({ excludeContent: '' });
    await ensureEmdashGitExcluded(fs, '/repo');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('creates the exclude entry when info/exclude is missing', async () => {
    const { fs, writeText } = makeFs({ gitType: 'directory', excludeContent: null });
    await ensureEmdashGitExcluded(fs, '/repo');
    expect(writeText).toHaveBeenCalledWith('/repo/.git/info/exclude', '.gugu/\n');
  });

  it('appends the entry, preserving existing exclude content', async () => {
    const { fs, writeText } = makeFs({
      gitType: 'directory',
      excludeContent: '# git ls-files\nbuild/\n',
    });
    await ensureEmdashGitExcluded(fs, '/repo');
    expect(writeText).toHaveBeenCalledWith(
      '/repo/.git/info/exclude',
      '# git ls-files\nbuild/\n.gugu/\n'
    );
  });

  it('does nothing when .gugu/ is already excluded', async () => {
    const { fs, writeText } = makeFs({
      gitType: 'directory',
      excludeContent: 'foo\n.gugu/\n',
    });
    await ensureEmdashGitExcluded(fs, '/repo');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('treats a slashless .gugu entry as already excluded', async () => {
    const { fs, writeText } = makeFs({ gitType: 'directory', excludeContent: '.gugu\n' });
    await ensureEmdashGitExcluded(fs, '/repo');
    expect(writeText).not.toHaveBeenCalled();
  });

  // 改名前建的仓里那行 `.emdash/` 还在,而且那个目录也还在。它不该拦住新目录的排除规则:
  // 少写这一行,新目录里的附件与粘贴的图片就会全部冒进用户的 `git status`。
  it('still adds the new entry to a repo that only excludes the old directory', async () => {
    const { fs, writeText } = makeFs({ gitType: 'directory', excludeContent: '.emdash/\n' });
    await ensureEmdashGitExcluded(fs, '/repo');
    expect(writeText).toHaveBeenCalledWith('/repo/.git/info/exclude', '.emdash/\n.gugu/\n');
  });

  it('does not rewrite when the exclude read was truncated', async () => {
    // A truncated view could miss an existing entry past the cut; rewriting it would
    // drop the tail of the file, so bail instead.
    const { fs, writeText } = makeFs({
      gitType: 'directory',
      excludeContent: 'build/\n',
      truncated: true,
    });
    await ensureEmdashGitExcluded(fs, '/repo');
    expect(writeText).not.toHaveBeenCalled();
  });
});
