import type { IExecutionContext } from '../../exec/execution-context';
import type { Platform } from '../capability';
import { createInstallMethodDetector, type InstallMethodDetector } from './method-detection';
import type { CustomTarget, DependencyId, HostDependencySelection, InstallRecord } from './types';

/**
 * 「这一家装没装 / 哪一份是咕咕装的 / 用户选了哪一份」这本**账**的读写口。
 *
 * 一台机器上只有一本(#6101)。账在主进程(桌面端 `host-dependency-store`:本机 KV +
 * SSH 连接的 metadata),别的进程 / 别的执行上下文**读同一本**,❌ 不自己再探一遍 ——
 * 同一台机器上两份读数,从来只有一份是对的,而界面分不出是哪一份。
 *
 * 分成口子而不是直接传三个回调,是为了让「谁在读这本账」在类型上说得出口:一个不写账的
 * 上下文(worker、远端)拿到的是同一本账的**副本**,它的 `setInstallRecord` 会响亮地拒绝,
 * ❌ 而不是悄悄写进一份没人看的第二本。
 */
export type HostDependencyLedger = {
  getSelection(depId: DependencyId): Promise<HostDependencySelection | null>;
  getInstallRecord(depId: DependencyId): Promise<InstallRecord | null>;
  setInstallRecord(depId: DependencyId, record: InstallRecord | null): Promise<void>;
  /** 上一次指定的自定义路径;没指定过就是 null。选中别的来源时它也还在。 */
  getLastCustom?(depId: DependencyId): Promise<CustomTarget | null>;
};

/** 咕咕自己那棵安装树的位置 —— 探测器据此把「我们亲手放的那份」判成 `ours`。 */
export type ManagedInstallDirs = {
  ownedNpmRoots: string[];
  ownedShimDirs: string[];
  ownedMiseBinDirs: string[];
};

export const EMPTY_MANAGED_INSTALL_DIRS: ManagedInstallDirs = {
  ownedNpmRoots: [],
  ownedShimDirs: [],
  ownedMiseBinDirs: [],
};

/** 账上一家的那一行。 */
export type HostDependencyLedgerEntry = {
  id: DependencyId;
  selection: HostDependencySelection;
  installRecord: InstallRecord | null;
  lastCustom?: CustomTarget | null;
  /**
   * 这一家**真跑起来时**那份环境(#5702)。路径解析和版本探测共用它,所以「面板上显示的装没装 / 什么版本」
   * 和用户按下开始时是同一个环境里的答案 —— 算它要读用户在设置里填的东西,那在主进程。
   */
  probeEnv?: Record<string, string>;
};

/** 主进程递出去的一整本账。 */
export type HostDependencyLedgerSnapshot = {
  ownedDirs: ManagedInstallDirs;
  entries: HostDependencyLedgerEntry[];
};

export type ReplicaHostDependencyLedger = HostDependencyLedger & {
  /** 收下主进程递来的那一份。 */
  apply(snapshot: HostDependencyLedgerSnapshot): void;
  ownedDirs(): ManagedInstallDirs;
  probeEnvFor(depId: DependencyId): Record<string, string> | undefined;
};

/**
 * 一本**只读的副本**:内容全部来自主进程递过来的快照,自己不探、不猜、不写。
 *
 * 没收到快照之前它如实答「没有」——「还没收到账本」和「账本上没有这一行」在读数上同形,
 * 但两者都不会让这个进程编出一个自己的答案,而那正是 #6101 要消掉的第二本账。
 */
export function createReplicaLedger(): ReplicaHostDependencyLedger {
  let ownedDirs: ManagedInstallDirs = EMPTY_MANAGED_INSTALL_DIRS;
  let entries = new Map<DependencyId, HostDependencyLedgerEntry>();

  return {
    apply(snapshot: HostDependencyLedgerSnapshot): void {
      ownedDirs = snapshot.ownedDirs;
      entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    },
    ownedDirs: () => ownedDirs,
    probeEnvFor: (depId) => entries.get(depId)?.probeEnv,
    getSelection: (depId) => Promise.resolve(entries.get(depId)?.selection ?? null),
    getInstallRecord: (depId) => Promise.resolve(entries.get(depId)?.installRecord ?? null),
    getLastCustom: (depId) => Promise.resolve(entries.get(depId)?.lastCustom ?? null),
    setInstallRecord: (depId) =>
      // 装不了的上下文不该产出安装记录。真的走到这里说明有人在这个进程里跑了安装 ——
      // ❌ 别静默吞掉:那会长出第二本账,而第二本账不会被任何人读。
      Promise.reject(
        new Error(
          `This host cannot own installs, so it cannot write an install record (${depId}). ` +
            'Install records are written by the process that ran the install.',
        ),
      ),
  };
}

/**
 * 跟着账本走的探测器 —— 咕咕自己那些目录由主进程告诉它,不在这个进程里另算一遍路径。
 *
 * 目录一换就整只重建:探测器里缓存着 brew / npm 的根查询结果,换了地基那些答案也该作废。
 */
export function createLedgerBackedDetector(
  ctx: IExecutionContext,
  platform: Platform,
  ledger: Pick<ReplicaHostDependencyLedger, 'ownedDirs'>,
): InstallMethodDetector {
  let built: { key: string; detector: InstallMethodDetector } | null = null;

  function current(): InstallMethodDetector {
    const dirs = ledger.ownedDirs();
    const key = JSON.stringify(dirs);
    if (!built || built.key !== key) {
      built = { key, detector: createInstallMethodDetector(ctx, platform, dirs) };
    }
    return built.detector;
  }

  return {
    detect: (realPath) => current().detect(realPath),
    invalidate: () => current().invalidate(),
    locateTarget: (target, binaryNames) => {
      const detector = current();
      return detector.locateTarget ? detector.locateTarget(target, binaryNames) : Promise.resolve([]);
    },
    targetSearchDirs: (target) => current().targetSearchDirs?.(target) ?? [],
  };
}
