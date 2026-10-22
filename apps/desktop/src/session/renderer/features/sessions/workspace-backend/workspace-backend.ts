// #6264 会话右侧工作区的「后端」—— 同一套界面(文件页签、文件树、审阅、diff、浏览器、终端),
// 换的只是「这条会话的文件在哪台机器上」。照 VS Code 远程的架构:编辑器与视图只有一份,
// 背后按资源所在的机器挑 provider(FileService.registerProvider(scheme, provider);
// https://code.visualstudio.com/api/advanced-topics/remote-extensions#architecture-and-extension-kinds
// 与 https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/common/fileService.ts)。
//
// 这里的「scheme」就是 projectId 的前缀:本机项目 = 本机后端(`rpc.workspace` 原样);
// `remote:<机器>` = 那台机器的后端(remote-hosts 在启动时登记)。所有组件只问 `workspaceBackend(projectId)`,
// ❌ 自己判「是不是远端」再分两条路 —— 那正是两套界面的来源。
//
// 事件同理:组件听 `workspaceEvents`(文件变了 / 文件树投影 / git 状态),本机的来自主进程,
// 别的机器的由它的后端在渲染层发出;形状一模一样。
import type { BrowseDirectoryResult } from '@shared/core/fs/fs';
import type { EventDefinition } from '@shared/lib/ipc/events';
import { events, rpc } from '@renderer/lib/ipc';
import { localWorkspaceBackend } from './local-workspace-backend';
import type { WorkspaceBrowserBackend } from './workspace-browser-backend';
import type { WorkspaceTerminalBackend } from './workspace-terminal-backend';
import type { WorkspaceTreeBackend } from './workspace-tree-backend';

/** 会话工作区的那组动词 —— 与本机 `rpc.workspace` 同名同形(文件、文件树投影、编辑器草稿、git)。 */
export type WorkspaceRpc = typeof rpc.workspace;

export interface WorkspaceBackend {
  /** 'local' = 这台电脑;否则是会话所在的那台机器。只给「怎么说」用(文案里的机器名),❌ 拿来分支渲染。 */
  readonly machine: { kind: 'local' } | { kind: 'remote'; deviceId: string; label: () => string };
  readonly rpc: WorkspaceRpc;
  /** 列一个目录(路径条的下拉)。 */
  browseDirectory(workspaceId: string, path: string): Promise<BrowseDirectoryResult>;
  /** 文件树里超出 `rpc.workspace` 的那几个动作(新建 / 改名 / 删除 / 导入 / 下载)。 */
  readonly tree: WorkspaceTreeBackend;
  /** 浏览器页签在这台机器上怎么加载地址(localhost 转到那台机器、`file:` 从那台机器取)。 */
  readonly browser: WorkspaceBrowserBackend;
  /** 终端页签的来源(本机 pty / 那台机器上经 SSH 开的 shell)。 */
  readonly terminal: WorkspaceTerminalBackend;
  /**
   * 提交时那台机器上的 git 不知道署谁的名字(`identity_unknown`):就地填一次、写进那台机器,接着把提交做完。
   * 这台电脑上没有这一格(署名由用户自己的 git 配置管)。
   */
  setGitIdentity?(workspaceId: string, identity: { name: string; email: string }): Promise<{ ok: true } | { ok: false; message: string }>;
}

type BackendResolver = (projectId: string) => WorkspaceBackend | null;

const resolvers: BackendResolver[] = [];

/** 登记一种「不在这台电脑上」的后端(别的机器)。返回撤销。 */
export function registerWorkspaceBackend(resolver: BackendResolver): () => void {
  resolvers.push(resolver);
  return () => {
    const at = resolvers.indexOf(resolver);
    if (at >= 0) resolvers.splice(at, 1);
  };
}

export function workspaceBackend(projectId: string): WorkspaceBackend {
  for (const resolve of resolvers) {
    const found = resolve(projectId);
    if (found) return found;
  }
  return localWorkspaceBackend;
}

/** 这条会话工作区的动词(`rpc.workspace` 的同形替身)。 */
export function workspaceRpc(projectId: string): WorkspaceRpc {
  for (const resolve of resolvers) {
    const found = resolve(projectId);
    if (found) return found.rpc;
  }
  return rpc.workspace;
}

// ── 事件:本机的来自主进程,别的机器的由它的后端在这里发 ───────────────────────────────

const rendererListeners = new Map<string, Set<(data: unknown) => void>>();

export const workspaceEvents = {
  /** 听一种工作区事件(本机主进程的,与打开着的别的机器上由它的后端发出的)。返回退订。 */
  on<T>(event: EventDefinition<T>, cb: (data: T) => void): () => void {
    const offIpc = events.on(event, cb);
    let set = rendererListeners.get(event.name);
    if (!set) {
      set = new Set();
      rendererListeners.set(event.name, set);
    }
    const wrapped = (data: unknown) => cb(data as T);
    set.add(wrapped);
    return () => {
      offIpc();
      rendererListeners.get(event.name)?.delete(wrapped);
    };
  },
  /** 别的机器的后端发一件事(只在渲染层里,❌ 送到主进程)。 */
  emit<T>(event: EventDefinition<T>, data: T): void {
    for (const cb of [...(rendererListeners.get(event.name) ?? [])]) {
      try {
        cb(data);
      } catch {
        // 一个听的人出错不挡别人(与 ipc 事件同一个口径)。
      }
    }
  },
};
