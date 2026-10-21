import type {
  DependencyId,
  HostDependencyLedger,
  HostDependencyLedgerSnapshot,
  ManagedInstallDirs,
} from '@gugu/session-core/deps/runtime';
import type { Platform } from '@gugu/session-core/deps';
import { resolveLocalAgentSpawnEnv } from '@main/core/agents/agent-run-context';
import { hostDependencyStore } from './host-dependency-store';
import {
  managedAgentBinDir,
  managedAgentNpmRoot,
  managedMiseBinDir,
} from './managed-agent-home';
import { AGENT_DEPENDENCIES } from './registry';

/**
 * 「装没装 / 谁装的 / 用户选了哪一份」这本账,在这台机器上的**属主视角**(#6101)。
 *
 * 一本账一个属主:持久化在 `hostDependencyStore`(本机 KV / SSH 连接 metadata),
 * 主进程的依赖管理器直接读它,读不到 KV 的进程(worker)读一份由这里递过去的副本。
 * ❌ 任何一侧都不许自己再探一遍「谁装的」—— 那就是 #6101 里同一台机器两份读数的来源。
 */
export function hostDependencyLedgerFor(hostId: string): HostDependencyLedger {
  return {
    getSelection: (depId) => hostDependencyStore.getSelection(hostId, depId),
    getInstallRecord: (depId) => hostDependencyStore.getInstallRecord(hostId, depId),
    setInstallRecord: (depId, record) =>
      hostDependencyStore.setInstallRecord(hostId, depId, record),
    getLastCustom: (depId) => hostDependencyStore.getLastCustom(hostId, depId),
  };
}

/**
 * 咕咕自己那棵安装树在**本机**的位置。
 *
 * 只有本机有:远端主机上咕咕装不了任何东西(#6098),那里不存在「咕咕自己的目录」——
 * 远端的 `ours` 只能来自安装记录,❌ 不许拿本机的路径去套远端的盘。
 */
export function localManagedInstallDirs(platform: Platform): ManagedInstallDirs {
  return {
    ownedNpmRoots: [managedAgentNpmRoot(platform)],
    ownedShimDirs: [managedAgentBinDir(platform)],
    ownedMiseBinDirs: [managedMiseBinDir()],
  };
}

/**
 * 把本机这本账整本抄一份给读不到 KV 的进程。
 *
 * 带上探测环境:量一家 agent 的版本要用它**真跑起来时**那份环境(#5702),而算那份环境要读
 * 用户在设置里填的东西 —— 只有主进程读得到。⇒ 算好了一起递过去,worker 那边不自己拼。
 */
export async function buildHostDependencyLedgerSnapshot(
  platform: Platform
): Promise<HostDependencyLedgerSnapshot> {
  const entries = await Promise.all(
    AGENT_DEPENDENCIES.map(async (descriptor) => {
      const id = descriptor.id as DependencyId;
      const [selection, installRecord, lastCustom, probeEnv] = await Promise.all([
        hostDependencyStore.getSelection('local', id),
        hostDependencyStore.getInstallRecord('local', id),
        hostDependencyStore.getLastCustom('local', id),
        // 伴随程序按属主那一家的环境探(#6335)。
        resolveLocalAgentSpawnEnv(descriptor.ownerId ?? id),
      ]);
      return { id, selection, installRecord, lastCustom, probeEnv };
    })
  );
  return { ownedDirs: localManagedInstallDirs(platform), entries };
}
