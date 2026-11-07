// 这台电脑上的会话工作区:动词就是 `rpc.workspace` 本身,其余几格照此前本机的做法。
// 与别的机器那一份(remote-hosts/workspace/remote-workspace-backend.ts)同形 —— 界面只认 WorkspaceBackend。
import { rpc } from '@renderer/lib/ipc';
import type { WorkspaceBackend } from './workspace-backend';
import type { WorkspaceTerminals } from './workspace-terminal-backend';

let localTerminals: (sessionId: string) => WorkspaceTerminals | null = () => null;

/**
 * 本机终端的来源由 terminal-registry 装上时登记 —— ❌ 在这里 import 它:那一串(终端 → pty)会被拖进
 * 每个只想读文件的模块(模型注册表、文件树),单测与启动都白白多背一截。
 */
export function bindLocalTerminals(get: (sessionId: string) => WorkspaceTerminals | null): void {
  localTerminals = get;
}


export const localWorkspaceBackend: WorkspaceBackend = {
  machine: { kind: 'local' },
  rpc: rpc.workspace,
  browseDirectory: (_workspaceId, path) => rpc.files.browseDirectory({ type: 'local', path }),
  elsewhere: false,
  browser: { available: true, persistent: true, attach: () => null },
  terminal: {
    available: true,
    persistent: true,
    terminals: (ctx) => localTerminals(ctx.sessionId),
  },
};
