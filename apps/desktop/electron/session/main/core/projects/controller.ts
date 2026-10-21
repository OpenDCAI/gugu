import { createRPCController } from '@shared/lib/ipc/rpc';
import { createProject, inspectProjectPath } from './operations/createProject';
import { deleteProject } from './operations/deleteProject';
import { getProjects } from './operations/getProjects';
import { openProject } from './operations/openProject';
import {
  attachProjectFolder,
  detachProjectFolder,
  listProjectFolders,
} from './operations/project-folders';
import {
  bindProjectToGroup,
  ensureProjectGroup,
  listProjectGroupBindings,
  unbindProjectGroup,
} from './operations/project-groups';
import {
  acquireProjectWorkspace,
  releaseProjectWorkspace,
} from './operations/project-workspace-lease';
import { countProjectsUsingGithubAccount } from './settings/count-projects-using-github-account';
import { projectSettingsService } from './settings/project-settings-service';

export const projectController = createRPCController({
  createProject,
  inspectProjectPath,
  getProjects,
  deleteProject,
  getProjectSettingsPage: (projectId: string) =>
    projectSettingsService.getProjectSettingsPage(projectId),
  updateProjectSettings: (projectId, settings) =>
    projectSettingsService.updateProjectSettings(projectId, settings),
  patchProjectSettings: (projectId, patch) =>
    projectSettingsService.patchProjectSettings(projectId, patch),
  shareProjectSettingsToConfig: (projectId, request) =>
    projectSettingsService.shareProjectSettingsToConfig(projectId, request),
  migrateProjectConfig: (projectId, request) =>
    projectSettingsService.migrateProjectConfig(projectId, request),
  countProjectsUsingGithubAccount,
  openProject,
  acquireProjectWorkspace,
  releaseProjectWorkspace,
  // #7341 项目挂的文件夹(product spec「挂文件夹」)
  listProjectFolders,
  attachProjectFolder,
  detachProjectFolder,
  // #7341 第二步 项目跨设备:项目的跨设备身份 = 它的项目群(product spec「挂文件夹」)
  listProjectGroupBindings,
  ensureProjectGroup,
  bindProjectToGroup,
  unbindProjectGroup,
});
