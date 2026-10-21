import type { FileError, IFileSystem, IFileTree } from '@gugu/session-core/files';
import type { Result } from '@gugu/session-shared';
import type { IGitWorktree } from '@gugu/session-core/git';
import type { FileTreeProjector } from '@main/core/files/file-tree/projector';
import type { GitRepositoryFetchService } from '@main/core/git/repository/fetch-service';
import type { GitRepositoryService } from '@main/core/git/repository/service';
import type { ProjectSettingsProvider } from '@main/core/projects/settings/provider';
import type { LifecycleScriptService } from './workspace-lifecycle-service';

export interface Workspace {
  readonly id: string;
  readonly path: string;
  readonly configPath: string;
  readonly fileSystem: IFileSystem;
  readonly fileTree: IFileTree;
  readonly fileTreeProjector: FileTreeProjector;
  // gugu #2358: 非 git 项目的工作区没有 git 仓/worktree —— 三个 git 成员缺省,git 专属功能降级。
  readonly gitWorktree: IGitWorktree | undefined;
  readonly settings: ProjectSettingsProvider;
  readonly lifecycleService: LifecycleScriptService;
  readonly gitRepository: GitRepositoryService | undefined;
  readonly gitRepositoryFetchService: GitRepositoryFetchService | undefined;
  /**
   * 打开着的文件所在的目录:界面打开文件时报进来,关掉时撤(见 IFilesRuntime.watchDirectory)。
   * 一个目录一个 watch 的平台上,这个工作区的变化流就只看这些目录 + 展开着的目录。工作区 dispose 时一并撤掉。
   */
  watchDirectory(dirPath: string): Result<() => void, FileError>;
  /**
   * 「这个工作区下面可能变过」:git status、App 这些粗粒度的整棵树订阅各重算一次(见 IWatchService.nudge)。
   * 返回有没有兑现:没有(一个根就看得到整棵树的平台)= 什么都不缺,调用方别跟着做重活。
   */
  nudge(): Promise<boolean>;
  dispose?(): void | Promise<void>;
}
