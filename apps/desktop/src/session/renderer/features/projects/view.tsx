import type { GuardResult } from '@renderer/app/view-registry';
import { ProjectViewWrapper } from '@renderer/features/projects/components/project-view-wrapper';
import { projectPresence } from './project-presence';
import { ProjectMainPanel } from './components/main-panel/main-panel';
import { ProjectTitlebar } from './components/project-titlebar';

export const projectView = {
  WrapView: ProjectViewWrapper,
  TitlebarSlot: ProjectTitlebar,
  MainPanel: ProjectMainPanel,
  canActivate: (params: unknown): GuardResult => {
    const projectId =
      typeof params === 'object' && params !== null
        ? (params as { projectId?: unknown }).projectId
        : undefined;
    if (typeof projectId !== 'string') return { ok: false, redirect: 'home' };
    return projectPresence(projectId) === 'deleted' ? { ok: false, redirect: 'home' } : { ok: true };
  },
};
