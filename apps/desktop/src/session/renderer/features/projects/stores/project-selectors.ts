import type { ProjectsTranslate } from '@renderer/localization/messages-projects';
import { isImplicitSessionHomeProject } from '@renderer/features/sessions/session-home-project-constants';
import { appState } from '@renderer/lib/stores/app-state';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { HOME_PROJECT_LABEL } from '@renderer/features/remote-hosts/machine-home';
import type { LocalProject } from '@shared/projects';
import type { GitRepositoryStore } from './git-repository-store';
import type { PrSyncStore } from './pr-sync-store';
import {
  isUnmountedProject,
  isUnregisteredProject,
  type MountedProject,
  type ProjectStore,
} from './project';
import type { ProjectManagerStore } from './project-manager';
import type { ProjectSettingsStore } from './project-settings-store';
import type { ProjectViewStore } from './project-view';

/** Returns the ProjectManagerStore from appState. Call only inside `observer` components (or other MobX reactions). */
export function getProjectManagerStore(): ProjectManagerStore {
  return appState.projects;
}

/** Call only inside `observer` components (or other MobX reactions). */
export function getProjectStore(projectId: string): ProjectStore | undefined {
  return getProjectManagerStore().projects.get(projectId);
}

/** Summary for routing the project shell; call only inside `observer` (or other MobX reactions). */
export type ProjectViewKind =
  | 'missing'
  | 'creating'
  | 'bootstrapping'
  | 'mount_error'
  | 'path_not_found'
  | 'permission_blocked'
  | 'idle_unmounted'
  | 'ready';

export function projectViewKind(store: ProjectStore | undefined): ProjectViewKind {
  if (!store) return 'missing';
  if (isUnregisteredProject(store)) return 'creating';
  if (isUnmountedProject(store)) {
    if (store.phase === 'opening') return 'bootstrapping';
    if (store.phase === 'error') {
      if (store.errorCode === 'path-not-found') return 'path_not_found';
      if (store.errorCode === 'path-access-blocked') return 'permission_blocked';
      return 'mount_error';
    }
    return 'idle_unmounted';
  }
  return 'ready';
}

/** Returns the mounted project payload if ready, otherwise undefined. */
export function asMounted(store: ProjectStore | undefined): MountedProject | undefined {
  return store?.mountedProject ?? undefined;
}

/**
 * Returns the id of the first mounted project on `machine` (null = this computer), or undefined if none are mounted.
 * #6264 别的机器上的项目也在这张表里:一个只该在某台机器上跑的东西(已安排),❌ 默认挑到另一台上的项目。
 */
export function firstMountedProjectId(machine: string | null = null): string | undefined {
  for (const [id, store] of getProjectManagerStore().projects.entries()) {
    if (isImplicitSessionHomeProject(store)) continue;
    if (machineRegistry.machineOf(id) !== machine) continue;
    if (asMounted(store)) return id;
  }
  return undefined;
}

export function mountedProjectData(
  store: ProjectStore | undefined
): LocalProject | null {
  return store?.mountedProject?.data ?? null;
}

/** Returns the display name from any project store variant. */
export function projectDisplayName(store: ProjectStore | undefined): string | undefined {
  // #6264 别的机器的主目录项目处处叫「~」(与侧栏那一行同名)。
  if (store && appState.sidebar?.homeLayout.homeRows.has(store.id)) return HOME_PROJECT_LABEL;
  return store?.name ?? undefined;
}

// The stored path and the backend's own error text are raw diagnostics; only
// the shell around them and the "no detail at all" fallback are localized.
export function unmountedMountErrorMessage(
  store: ProjectStore | undefined,
  translate: ProjectsTranslate
): string {
  if (store && isUnmountedProject(store) && store.phase === 'error') {
    if (store.errorCode === 'path-not-found') {
      return translate('projects.error.notFoundAtPath', {
        path: store.error ?? translate('projects.error.configuredPath'),
      });
    }
    return store.error ?? translate('projects.error.openFailed');
  }
  return translate('projects.error.openFailed');
}

/** Returns the GitRepositoryStore for a mounted project, or undefined if not ready. */
export function getGitRepositoryStore(projectId: string): GitRepositoryStore | undefined {
  return asMounted(getProjectStore(projectId))?.gitRepository;
}

/** Returns the ProjectSettingsStore for a mounted project, or undefined if not ready. */
export function getProjectSettingsStore(projectId: string): ProjectSettingsStore | undefined {
  return asMounted(getProjectStore(projectId))?.settings;
}

/** Returns the PrSyncStore for a mounted project, or undefined if not ready. */
export function getPrSyncStore(projectId: string): PrSyncStore | undefined {
  return asMounted(getProjectStore(projectId))?.prSync;
}

/** Returns the ProjectViewStore for a mounted project, or undefined if not ready. */
export function getProjectViewStore(projectId: string): ProjectViewStore | undefined {
  return asMounted(getProjectStore(projectId))?.view;
}
