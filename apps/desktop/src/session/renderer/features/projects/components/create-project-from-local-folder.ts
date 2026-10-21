import { rendererLogger } from '@/lib/log';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { toast } from '@renderer/lib/hooks/use-toast';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import { basenameFromAnyPath } from '@shared/path-name';
import {
  isProjectPathConflictError,
  projectPathConflictMessage,
} from '../stores/project-creation-error';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

const log = rendererLogger('projects/create-from-local-folder');

/**
 * 「使用现有文件夹」建项目:项目名 = 文件夹名,不初始化 git,也不要求是 git 仓库(product spec
 * 「使用现有文件夹」:所选目录本身就是项目路径,不自动初始化或改写;非 git 与远程项目同口径放行,#2358)。
 * 菜单(桌面版,系统对话框选路径)与网页版弹窗(应用内目录树选路径)共用这一段;失败返回 null。
 * 失败时**原因进日志、文案只给用户能照做的下一步**:底层那句是给我们看的诊断串(路径、errno、内部
 * 标签),摆给用户既看不懂也不指向任何动作。❌ 也别写「请重试」——重试不是用户能改变结果的动作。
 */
export async function createProjectFromLocalFolder(
  path: string,
  translate: Translate
): Promise<string | null> {
  const name = basenameFromAnyPath(path);
  if (!name) {
    toast({
      title: translate('projects.create.folderUnusable'),
      description: translate('projects.create.folderNameUnreadable'),
      variant: 'destructive',
    });
    return null;
  }
  const projectManager = getProjectManagerStore();
  const pendingProjectId = crypto.randomUUID();
  try {
    const projectId = await projectManager.createProject(
      { type: 'local' },
      { mode: 'pick', path, name, initGitRepository: false, allowNonGit: true },
      pendingProjectId
    );
    if (!projectId) {
      const detail = projectManager.projects.get(pendingProjectId)?.error;
      projectManager.removeUnregisteredProject(pendingProjectId);
      throw new Error(detail ?? translate('projects.create.failed'));
    }
    return projectId;
  } catch (error) {
    projectManager.removeUnregisteredProject(pendingProjectId);
    log.error(
      { path, error: error instanceof Error ? error.message : String(error) },
      '用现有文件夹建项目失败'
    );
    const userDescription = isProjectPathConflictError(error)
      ? projectPathConflictMessage(error, translate)
      : translate('projects.create.folderUnusableDetail');
    toast({
      title: translate('projects.create.folderUnusable'),
      description: userDescription,
      variant: 'destructive',
    });
    return null;
  }
}
