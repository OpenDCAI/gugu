import { gitErrorMessage } from '@gugu/session-core/git';
import { err, ok } from '@gugu/session-shared';
import type { GitRepositorySnapshotResult } from '@shared/core/git/rpc';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { projectManager } from '../../projects/project-manager';
import { providerRepositoryService } from '../../repository/provider-repository-service';
import { workspaceRegistry } from '../../workspaces/workspace-registry';

export const gitRepositoryController = createRPCController({
  /**
   * #6264 这台电脑上 git 的署名(`git config --global user.name / user.email`)。别的机器上的 git 还没配署名时,
   * 审阅页就地问一句,输入框里默认填这一份(同一个人在自己电脑上用的名字)。取不到就是空串。
   */
  localIdentity: async (): Promise<{ name: string; email: string }> => {
    const [{ execFile }, { promisify }, os, { reviewGitEnv }, { getGitExecutable }, { loginShellEnv }] = await Promise.all([
      import('node:child_process'),
      import('node:util'),
      import('node:os'),
      import('../../runtime/review-git-env'),
      import('../../utils/exec'),
      import('@main/utils/userEnv'),
    ]);
    const run = promisify(execFile);
    const options = { cwd: os.homedir(), env: reviewGitEnv({ processEnv: process.env, loginShellEnv: loginShellEnv() }), timeout: 5_000 };
    const read = (key: string) =>
      run(getGitExecutable(), ['config', '--global', '--get', key], options).then(
        ({ stdout }) => stdout.trim(),
        () => ''
      );
    const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
    return { name, email };
  },

  getRepoSnapshot: async (projectId: string): Promise<GitRepositorySnapshotResult> => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    // gugu #2358: 非 git 项目无仓 —— git RPC 对其无意义(renderer store 已短路不调,此为防御)。
    if (!project.gitRepository) return err({ type: 'not_found' as const });
    try {
      return ok(await project.gitRepository.getSnapshot());
    } catch (e) {
      return err({ type: 'git_error' as const, message: gitErrorMessage(e) });
    }
  },

  getProjectRootHead: async (projectId: string) => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    try {
      return ok({ head: await project.getProjectRootHead() });
    } catch (e) {
      return err({ type: 'git_error' as const, message: gitErrorMessage(e) });
    }
  },

  getDefaultBranch: async (projectId: string) => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    if (!project.gitRepository) return err({ type: 'not_found' as const });
    try {
      return ok({ defaultBranch: await project.gitRepository.getDefaultBranch() });
    } catch (e) {
      return err({ type: 'git_error' as const, message: gitErrorMessage(e) });
    }
  },

  resolveProviderRepository: async (projectId: string) => {
    return providerRepositoryService.resolveProject(projectId);
  },

  addRemote: async (projectId: string, name: string, url: string) => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    if (!project.gitRepository) return err({ type: 'not_found' as const });
    const result = await project.gitRepository.addRemote(name, url);
    if (!result.success) return err(result.error);
    return ok();
  },

  fetch: async (projectId: string, workspaceId?: string) => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });

    let result;
    if (workspaceId) {
      const ws = workspaceRegistry.get(workspaceId);
      // gugu #2358: 非 git 工作区无 fetch 服务 → 回落到项目级 fetch(对非 git 亦返回空序列成功)。
      result =
        ws && ws.gitRepositoryFetchService
          ? await ws.gitRepositoryFetchService.fetch()
          : await project.fetch();
    } else {
      result = await project.fetch();
    }

    if (!result.success) return err(result.error);
    return result;
  },

  publishBranch: async (
    projectId: string,
    branchName: string,
    remote: string,
    // 界面仍按原契约传它;从前只用来给遥测打标签,遥测拆了之后这里不再读。
    _workspaceId?: string
  ) => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    if (!project.gitRepository) return err({ type: 'not_found' as const });
    const result = await project.gitRepository.publishBranch(branchName, remote);
    return result;
  },

  fetchPrForReview: async (
    projectId: string,
    prNumber: number,
    headRefName: string,
    headRepositoryUrl: string,
    isFork: boolean
  ) => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    if (!project.gitRepository) return err({ type: 'not_found' as const });
    const baseRemote = await project.gitRepository.getBaseRemote();
    const result = await project.gitRepository.fetchPrForReview(
      prNumber,
      headRefName,
      headRepositoryUrl,
      headRefName,
      isFork,
      baseRemote
    );
    if (!result.success) return err(result.error);
    return ok({ localBranch: headRefName });
  },
});
