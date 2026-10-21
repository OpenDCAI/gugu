import type { ProjectProvider } from '@main/core/projects/project-provider';
import type { WorkspaceFactoryContext } from './workspace-factory';

export type WorkspaceGitContext = Pick<
  WorkspaceFactoryContext,
  'gitless' | 'gitProbePath' | 'gitRepository' | 'gitRepositoryFetchService'
>;

/**
 * 工作区的 git 跟着哪个文件夹走(#7341 项目挂的文件夹)。
 *
 * - 根目录,以及从前的 worktree 行:沿用项目已经开着的那一套 git 服务 —— 行为一字不改。
 * - 挂上来的文件夹(`kind = 'path'`):它是它自己的仓库,或者根本不是仓库。❌ 借根目录的 git 服务 —— 那是另一个
 *   仓库的分支与远端;是不是 git 照它自己的目录判,是就由工作区自己开一套(workspace-factory 不注入时自建)。
 */
export function workspaceGitContext(
  project: Pick<ProjectProvider, 'isGitless' | 'gitRepository' | 'gitRepositoryFetchService'>,
  folder: { kind?: string | null; path: string }
): WorkspaceGitContext {
  if (folder.kind === 'path') {
    return {
      gitless: false,
      gitProbePath: folder.path,
      gitRepository: undefined,
      gitRepositoryFetchService: undefined,
    };
  }
  return {
    gitless: project.isGitless, // gugu #2358
    gitRepository: project.gitRepository,
    gitRepositoryFetchService: project.gitRepositoryFetchService,
  };
}
