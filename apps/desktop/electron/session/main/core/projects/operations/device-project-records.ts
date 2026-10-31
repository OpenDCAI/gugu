import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject';
import { tapMainEvents } from '@main/lib/events';
import {
  projectCreatedChannel,
  projectDeletedChannel,
  projectFoldersChangedChannel,
  projectGroupBindingChangedChannel,
  projectVisibilityChangedChannel,
} from '@shared/core/projects/projectEvents';
import { sessionCreatedChannel } from '@shared/core/sessions/sessionEvents';
import { getProjects } from './getProjects';
import { listProjectFolderRefs } from './project-folders';
import { listProjectGroupBindings } from './project-groups';

/**
 * #113 这台机器记到账号上的那一份项目(product spec「项目」:项目记在账号上)。
 *
 * 与这台机器连着时别的端读到的是同一份:项目清单同 `projects.getProjects()`(❌ 隐藏的项目),文件夹同
 * `listProjectFolders` 去掉分支与会话这两个此刻的读数,群同 `listProjectGroupBindings`。
 * 绑定读不到就整份不出(抛):少了群的那一份记上去,别的端会把本该合成一行的项目拆开,比晚一点记上去更糟。
 */
export async function listDeviceProjectRecords(): Promise<DeviceProject[]> {
  const projects = await getProjects();
  const bindings = await listProjectGroupBindings();
  if (!bindings.success) {
    throw new Error(`device projects: project group bindings unavailable (${bindings.error.type}: ${bindings.error.message})`);
  }
  const bindingOf = new Map(bindings.data.map((binding) => [binding.projectId, binding]));
  const records: DeviceProject[] = [];
  for (const project of projects) {
    // #609 workspace(任务工作区、~、助理与 App 的目录)不是项目:不记到账号上,别的端也就不会把它当项目列出来。
    if (project.kind === 'workspace' || isImplicitSessionHomeProjectId(project.id)) continue;
    const folders = await listProjectFolderRefs(project.id);
    // 两次读之间刚被删掉的项目:它的删除事件会再触发一次,这一份不带它。
    if (!folders) continue;
    const binding = bindingOf.get(project.id);
    records.push({
      localProjectId: project.id,
      name: project.name,
      rootPath: project.path,
      createdAt: isoFromProjectTimestamp(project.createdAt),
      chatId: binding?.chatId ?? null,
      folders,
    });
  }
  return records;
}

/** 项目表的时间是 SQLite `CURRENT_TIMESTAMP`(UTC,`YYYY-MM-DD HH:MM:SS`,不带时区):记到账号上前写明是 UTC。 */
export function isoFromProjectTimestamp(value: string): string {
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const ms = Date.parse(utc);
  if (!Number.isFinite(ms)) throw new Error(`device projects: unreadable project timestamp ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}

/**
 * 记到账号上的那一份可能变了:项目建 / 删 / 显隐、文件夹挂 / 摘、群绑定变了。会话建起来也算 —— 在隐藏的项目里开会话
 * 会让它重新显出来,而那一下没有显隐事件。项目没有改名这件事(名字只在建时写)。返回退订。
 * 订阅要在会话页后端 boot 之后(同 onEmdashSessionpageReapTrigger)。
 */
export function onDeviceProjectsMaybeChanged(listener: () => void): () => void {
  const channels = new Set(
    [
      projectCreatedChannel,
      projectDeletedChannel,
      projectFoldersChangedChannel,
      projectVisibilityChangedChannel,
      projectGroupBindingChangedChannel,
      sessionCreatedChannel,
    ].map((channel) => channel.name)
  );
  return tapMainEvents((channel) => {
    if (channels.has(channel)) listener();
  });
}
