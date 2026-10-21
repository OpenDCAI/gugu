import type { IGitRepository, IGitRuntime } from '@gugu/session-core/git';
import { gitErrorMessage } from '@gugu/session-core/git';
import { err, ok, type Result } from '@gugu/session-shared';
import { log } from '@main/lib/logger';
import {
  remoteNameFromQualifiedRef,
  resolveBaseRefFromRemoteDefault,
} from '@shared/core/git/utils';
import type { CreateProjectError } from '@shared/projects';

export async function resolveProjectBaseRef(
  git: IGitRepository,
  detectedBaseRef: string
): Promise<string> {
  const remoteName = remoteNameFromQualifiedRef(detectedBaseRef);
  if (!remoteName) return detectedBaseRef;

  try {
    const [gitDefaultBranch, refs] = await Promise.all([
      git.getDefaultBranch(remoteName),
      git.getRefs(),
    ]);
    return resolveBaseRefFromRemoteDefault({
      detectedBaseRef,
      gitDefaultBranch,
      branches: refs.branches,
    });
  } catch (error) {
    log.debug('Failed to resolve project base ref, using detected base ref', {
      detectedBaseRef,
      error,
    });
  }

  return detectedBaseRef;
}

export async function ensureProjectRepository(
  git: IGitRuntime,
  path: string,
  initGitRepository?: boolean,
  allowNonGit?: boolean
): Promise<Result<{ rootPath: string; baseRef: string | null }, CreateProjectError>> {
  const ensured = await git.ensureRepository(path, { initIfMissing: initGitRepository ?? false });
  if (!ensured.success) {
    // gugu #2358: 远程项目放行非 git 目录(product spec「非 git 放行」)。未请求初始化时,
    // 用目录本身当 rootPath、baseRef=null 标记非 git —— 不再对 not-repository 硬失败。
    if (allowNonGit && ensured.error.type === 'not-repository') {
      return ok({ rootPath: path, baseRef: null });
    }
    return err(ensured.error);
  }

  const repoLeaseResult = await git.openRepository(ensured.data.rootPath).then(
    (lease) => ok(lease),
    (error: unknown) => err(error)
  );
  if (!repoLeaseResult.success) {
    return err({
      type: 'open-repository-failed',
      path: ensured.data.rootPath,
      message: gitErrorMessage(repoLeaseResult.error),
    });
  }
  const repoLease = repoLeaseResult.data;

  try {
    const baseRef = await resolveProjectBaseRef(repoLease.value, ensured.data.baseRef);
    return ok({ rootPath: ensured.data.rootPath, baseRef });
  } finally {
    await repoLease.release();
  }
}
