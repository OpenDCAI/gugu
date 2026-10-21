import type {
  CreateProjectParams,
  CreateProjectResult,
  InspectProjectPathParams,
  ProjectPathInspection,
} from '@shared/projects';
import { createLocalProject, getLocalProjectPathStatus } from './create-local-project';
import { getLocalProjectByPath, getProjectPathOccupant } from './getProjects';
import { getProjectOwningAttachedFolder } from './project-folders';

export async function createProject(params: CreateProjectParams): Promise<CreateProjectResult> {
  const { type: _type, ...localParams } = params;
  return createLocalProject(localParams);
}

export async function inspectProjectPath(
  params: InspectProjectPathParams
): Promise<ProjectPathInspection> {
  const [status, rootProject, attachedOwner] = await Promise.all([
    getLocalProjectPathStatus(params.path),
    getLocalProjectByPath(params.path),
    // #7341 挂在某个项目下的文件夹:认作那个项目(一个文件夹只属于一个项目)。
    getProjectOwningAttachedFolder(params.path),
  ]);
  const existingProject = attachedOwner ?? rootProject;
  return {
    ...status,
    existingProject,
    pathConflict: existingProject ? undefined : await getProjectPathOccupant(params.path),
  };
}
