import type { Result } from '@gugu/session-shared';
import type { CreateProjectError } from '@shared/projects';

interface BaseModeData {
  name: string;
  path: string;
}

export interface PickModeData extends BaseModeData {
  mode: 'pick';
  initGitRepository?: boolean;
  createDirectory?: boolean;
  /** 非 git 目录也放行(本地「使用现有文件夹」);远程项目在主进程侧本就放行。 */
  allowNonGit?: boolean;
  githubAccountId?: string;
}

export interface CloneModeData extends BaseModeData {
  mode: 'clone';
  repositoryUrl: string;
}

export interface NewModeData extends BaseModeData {
  mode: 'new';
  repositoryName: string;
  repositoryOwner: string;
  repositoryVisibility: 'public' | 'private';
  githubAccountId?: string;
}

export type ModeData = PickModeData | CloneModeData | NewModeData;

/** machine:#6264 在哪台机器上建(那台机器上的文件夹);缺席 = 本机。 */
export type ProjectType = { type: 'local'; machine?: string | null };

export type ProjectCreationError =
  | CreateProjectError
  | { type: 'clone-failed'; message: string }
  | { type: 'repository-create-failed'; message: string }
  | { type: 'repository-response-incomplete'; message: string }
  | { type: 'initialize-failed'; message: string };

export type ProjectCreationCompletion = Result<void, ProjectCreationError>;

export type StartProjectCreationResult =
  | { kind: 'existing'; projectId: string }
  | { kind: 'creating'; projectId: string; completion: Promise<ProjectCreationCompletion> };

export interface StartProjectCreationOptions {
  id?: string;
}
