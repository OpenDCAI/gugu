// #7199 桌面:在它家那台的任务工作区里读写助理目录，不把目录登记为项目。
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { rpcOn } from '@renderer/lib/ipc';
import { ensureImplicitSessionHomeProjectId } from '@renderer/features/sessions/implicit-session-home-project';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { homeTarget } from './assistant-home-sessions';
import { openMachineWith, type AssistantMachine } from './assistant-machine-core';

export * from './assistant-machine-core';

/** Reuse the machine's task workspace; keep the assistant's real directory as a file capability. */
export async function openAssistantMachine(home: AssistantHomePlace, workdir: string): Promise<AssistantMachine> {
  const target = homeTarget(home);
  const rpc = rpcOn(target);
  const projectId = target === null ? await ensureImplicitSessionHomeProjectId() : await remoteHostsStore.ensureTaskWorkspace(home.deviceId, true);
  if (!projectId) throw new Error('Task workspace is unavailable');
  const acquired = await rpc.projects.acquireTaskDirectory(projectId, workdir);
  if (!acquired.success) throw new Error(`Could not open the assistant directory: ${acquired.error.type}`);
  const homeDir = target === null ? await rpc.app.getHomeDirectory() : await remoteHostsStore.ensureHomeDir(home.deviceId);
  return { ...(await openMachineWith(rpc, { deviceId: home.deviceId, projectId, workspaceId: acquired.data.workspaceId, home: homeDir, workdir, kind: home.kind })), target };
}
