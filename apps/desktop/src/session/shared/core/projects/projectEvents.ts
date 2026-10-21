import { defineEvent } from '@shared/lib/ipc/events';
import type { Project } from '@shared/projects';

export const projectCreatedChannel = defineEvent<{
  project: Project;
}>('project:created');

/**
 * 项目在它那台机器上没了。删它的可能不是看着的这个窗口 —— 那台机器自己的窗口、或别的电脑撤销「把文件夹接进来」(#7341):
 * 收到后从清单里去掉,❌ 留一个点不开的残影等下次重连。
 */
export const projectDeletedChannel = defineEvent<{
  projectId: string;
}>('project:deleted');

export const projectSettingsChangedChannel = defineEvent<{
  projectId: string;
}>('project:settings-changed');

/** #7341 项目挂的文件夹变了(挂上 / 摘下):收到后重读 `projects.listProjectFolders(projectId)`。 */
export const projectFoldersChangedChannel = defineEvent<{
  projectId: string;
}>('project:folders-changed');

/** Folder membership changed the project list; its history and identity still exist. */
export const projectVisibilityChangedChannel = defineEvent<{
  projectId: string;
  project: Project | null;
}>('project:visibility-changed');

/**
 * #7341 第二步 这台机器上某个本地项目绑的项目群变了(并进来 / 撤销 / 第一个会话建了群 / 项目没了忘掉):
 * 收到后重读 `projects.listProjectGroupBindings()`。
 */
export const projectGroupBindingChangedChannel = defineEvent<{
  projectId: string;
}>('project:group-binding-changed');
