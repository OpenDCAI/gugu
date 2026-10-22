import type { GuardResult } from '@renderer/app/view-registry';
import { ProjectViewWrapper } from '@renderer/features/projects/components/project-view-wrapper';
import { appState } from '@renderer/lib/stores/app-state';

/**
 * 看一个项目(gugu-dev#181:项目是一块,第一枚页签是项目群)。项目画在这屏的项目块里(app/project-block.tsx),
 * 和会话块同一屏、能拼在一组 —— 所以这里只有参数和守卫,主区由 Workspace 按「这屏」画。
 */
export const projectView = {
  WrapView: ProjectViewWrapper,
  MainPanel: () => null,
  canActivate: (params: unknown): GuardResult => {
    const projectId =
      typeof params === 'object' && params !== null
        ? (params as { projectId?: unknown }).projectId
        : undefined;
    if (typeof projectId !== 'string') return { ok: false, redirect: 'home' };
    return appState.projects.projects.has(projectId) ||
      appState.projects.pendingCreationIds.has(projectId)
      ? { ok: true }
      : { ok: false, redirect: 'home' };
  },
};
