// #113 账号上记着的一台机器的项目(product spec「项目」:项目记在账号上)换成会话页里同一套形状:项目清单、群绑定、文件夹。
// 没连着那台机器时,侧栏、项目首页、文件夹卡读的都是这一份;连着时以那台机器此刻的回答为准。
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject';
import type { ProjectFolder } from '@shared/core/projects/project-folders';
import type { ProjectGroupBinding } from '@shared/core/projects/project-groups';
import type { LocalProject } from '@shared/projects';
import { machineCodec } from '@renderer/lib/machine-routing';

/**
 * 那台机器的项目表记时间的写法(SQLite `CURRENT_TIMESTAMP`,UTC,`YYYY-MM-DD HH:MM:SS`):侧栏按它与本机、连着的机器的
 * 项目一起排,写法不同就排乱了。账号上记的是 ISO(带时区),换回来。
 */
export function machineTimestamp(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}

/** 那台机器上的 id 进到这边:固定 id 的隐藏任务工作区换成 `<固定 id>~<机器>`(与经那台机器的连接读到的同一个名字)。 */
function inbound(deviceId: string, records: readonly DeviceProject[]): readonly DeviceProject[] {
  return machineCodec(deviceId).inbound(records);
}

/** 项目清单(同那台机器 `projects.getProjects()` 的回答)。git 与否、仓库根的工作区由挂上时那台机器答。 */
export function accountProjectsOf(deviceId: string, records: readonly DeviceProject[]): LocalProject[] {
  return inbound(deviceId, records).map((record) => {
    const createdAt = machineTimestamp(record.createdAt);
    const root = record.folders.find((folder) => folder.kind === 'root');
    return {
      type: 'local',
      id: record.localProjectId,
      name: record.name,
      path: record.rootPath,
      // 挂上时那台机器会答;没挂之前用不到(git 与否只在挂上之后才起作用)。
      baseRef: null,
      repositoryWorkspaceId: root?.workspaceId ?? null,
      ...(root ? {} : { rootFolderDetached: true }),
      createdAt,
      updatedAt: createdAt,
    };
  });
}

/** 群绑定(同那台机器 `projects.listProjectGroupBindings()` 的回答)。 */
export function accountBindingsOf(deviceId: string, records: readonly DeviceProject[]): ProjectGroupBinding[] {
  return inbound(deviceId, records).flatMap((record) =>
    record.chatId
      ? [{ projectId: record.localProjectId, chatId: record.chatId, ...(record.groupRepresentative ? { representative: true } : {}) }]
      : []
  );
}

/**
 * 一个项目的文件夹(同 `projects.listProjectFolders(projectId)`,少了此刻的读数):分支与在跑的会话只有那台机器连着时才知道,
 * 这里是 null 与空,读的一方把它们画成离线(❌ 当成「不是 git 仓库」「没有会话」)。账号上没有这个项目 = null。
 */
export function accountFoldersOf(deviceId: string, records: readonly DeviceProject[], projectId: string): ProjectFolder[] | null {
  const record = inbound(deviceId, records).find((item) => item.localProjectId === projectId);
  if (!record) return null;
  return record.folders.map((folder) => ({
    workspaceId: folder.workspaceId,
    projectId,
    kind: folder.kind,
    path: folder.path,
    branch: null,
    sessionIds: [],
    attachedAt: folder.attachedAt,
  }));
}

/**
 * #113 之前每台桌面各记一份的那几样(各台机器的项目清单、主目录、群绑定、文件夹),换成账号上的那份之后不再读写:
 * 开机清掉,❌ 留着别的机器上的路径在这台电脑上。
 */
const RETIRED_PROJECT_CACHE_KEYS = [
  'gugu:machine-projects:v1',
  'gugu:machine-home-dirs:v1',
  'gugu.projectGroups.v1',
  'gugu.projectFolders.v1',
] as const;

export function forgetRetiredProjectCaches(storage: Pick<Storage, 'removeItem'> | null): void {
  for (const key of RETIRED_PROJECT_CACHE_KEYS) {
    try {
      storage?.removeItem(key);
    } catch {
      /* 清不掉只是留着一份没人读的旧数据 */
    }
  }
}
