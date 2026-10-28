// #7199 桌面:把它家那台上的项目挂上再读写(核心在 assistant-machine-core.ts,手机壳用同一份核心)。
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { appState } from '@renderer/lib/stores/app-state';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { homeTarget } from './assistant-home-sessions';
import { openMachineWith, type AssistantMachine } from './assistant-machine-core';

export * from './assistant-machine-core';

/**
 * 拿到它家那台上读写用的工作区 —— 之后的读写都在它名下。那台机器要已经连上(住眼前这台 = 一直连着)。
 * `workdir` = 助理那条会话跑在哪个目录(它的记忆按这个目录记;云上 cloudpc.8 起是 ~/助理,❌ 假定主目录)。
 * - 云上:主目录项目(整台都是它的家,说明 / 记忆 / 资料都在主目录下);
 * - 住电脑:它自己的工作目录那个项目(它的一切都在这一个目录里,见 assistantHomePaths);眼前这台走本机,❌ 绕远程连自己。
 */
export async function openAssistantMachine(home: AssistantHomePlace, workdir: string): Promise<AssistantMachine> {
  const target = homeTarget(home);
  if (home.kind === 'cloud') {
    const projectId = await remoteHostsStore.ensureHomeProject(home.deviceId);
    const homeDir = await remoteHostsStore.ensureHomeDir(home.deviceId);
    return openMachineWith(rpcOn(home.deviceId), { deviceId: home.deviceId, projectId, home: homeDir, workdir, kind: 'cloud' });
  }
  const rpc = rpcOn(target);
  const projectId = target === null ? await localProjectOf(workdir) : await remoteHostsStore.ensureProject(home.deviceId, workdir, true);
  const homeDir = target === null ? await rpc.app.getHomeDirectory() : await remoteHostsStore.ensureHomeDir(home.deviceId);
  return { ...(await openMachineWith(rpc, { deviceId: home.deviceId, projectId, home: homeDir, workdir, kind: 'computer' })), target };
}

/** 本机上它工作目录那个项目(建它那一步已经把目录登记成项目);还没登记就登记一下(与「打开文件夹」同一步)。 */
async function localProjectOf(workdir: string): Promise<string> {
  const existing = [...appState.projects.projects.values()].find(
    (project) => machineRegistry.machineOf(project.id) === null && project.data?.path === workdir
  );
  if (existing) {
    await appState.projects.ensureMounted(existing.id);
    return existing.id;
  }
  const name = workdir.replace(/\/+$/, '').split('/').pop() || workdir;
  const projectId = await appState.projects.createProject(
    { type: 'local' },
    { mode: 'pick', path: workdir, name, initGitRepository: false, createDirectory: false, allowNonGit: true, automatic: true }
  );
  if (!projectId) throw new Error(`could not open ${workdir} as a project on this computer`);
  await appState.projects.ensureMounted(projectId);
  return projectId;
}
