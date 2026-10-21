import { DEFAULT_NPM_REGISTRY_ID, type InstallOption } from '@gugu/session-core/deps';
import { toPlatform } from '@gugu/session-core/deps/runtime';
import {
  installationCanUpdate,
  resolveActiveInstallation,
  type DependencyDescriptor,
  type DependencyId,
  type DependencyState,
  type DependencyStatusUpdatedEvent,
  type HostDependency,
  type Installation,
  type HostDependencyManager,
} from '@gugu/session-core/deps/runtime';
import type { Logger } from '@gugu/session-core/lib';
import semver from 'semver';
import { events } from '@main/lib/events';
import type { InstallSourceVersions } from '@shared/core/agents/agent-payload';
import { agentInstallationStatusUpdatedChannel } from '@shared/events/appEvents';
import { toAgentInstallationStatus } from '../agents/agent-payload-builder';
import { foldAgentPrograms } from '../agents/agent-programs';
import { getPlugin } from '../agents/plugin-registry';
import { agentProgramsOf } from '@gugu/session-core/deps/runtime';
import type { AgentInstallationStatus } from '@shared/core/agents/agent-payload';
import { LatestVersionService } from './latest-version-service';
import { probeInstallSources, rankInstallSources } from './install-source-race';
import { getDependencyDescriptor } from './registry';

/**
 * Parse a published version for comparison.
 *
 * `semver.parse` first so prereleases keep their identifier — `coerce` alone reduces
 * `2.1.0-rc.4` to `2.1.0`, which would rank a mirror an entire prerelease train behind as equal
 * to the newest source and leave it unmarked while the two version strings visibly differ.
 * `coerce` remains the fallback for tags that are not strictly semver (e.g. a leading `v`).
 */
function parseVersion(version: string | null): semver.SemVer | null {
  if (!version) return null;
  return semver.parse(version) ?? semver.coerce(version);
}

/**
 * The machine an install would land on, in npm's own `os`-`cpu` vocabulary — which is what
 * platform package names are built from (`…-darwin-arm64`, `…-linux-x64`).
 */
export type InstallTarget = { platform: string; arch: string };

function isNewerVersion(installed: string, latest: string): boolean {
  const a = semver.coerce(installed);
  const b = semver.coerce(latest);
  if (a === null || b === null) return false;
  return semver.gt(b, a);
}

type UpdateInfo = {
  latestVersion: string | null;
  updateAvailable: boolean;
};

type StoredEvent = {
  raw: DependencyStatusUpdatedEvent;
  installedVersion: string | null;
};

/**
 * Desktop orchestrator for update-availability.
 * Owns the LatestVersionService and computes latestVersion/updateAvailable per dependency.
 * Subscribes to manager.onStatusUpdated events, enriches them with update info, and
 * emits the enriched events on the desktop event channels.
 *
 * A single instance is shared across local and SSH managers (latest-version is host-agnostic;
 * updateAvailable is computed per-host from each host's reported installed version).
 *
 * Gating: each installation's updateAvailable is additionally gated through
 * installationCanUpdate() — unknown-source installs with a package-manager strategy
 * report updateAvailable=false so the row badge and card stay in sync.
 */
export class AgentUpdateService {
  /**
   * 只在这里用。安装进度条的总量不从它取 —— 那是 mise 自己进度行里的一手计数
   * (`mise-process.ts` 的 `miseProgress`,#6335 删掉了从前那条没人读的「预估总量」链)。
   */
  private readonly latestVersionService: LatestVersionService;
  private readonly logger?: Logger;
  /** Cache of latest versions keyed by dependency and, for npm, registry. */
  private latestVersionCache = new Map<string, string | null>();

  /**
   * 上一趟测速排出来的下载源顺序,按依赖 id 存。第一条 = 这次用哪个源,后面的是换源重试的候选。
   *
   * 只活在进程内存里、也只是一个**偏好**:没有读数时安装照旧走 descriptor 的推荐源,
   * ❌ 不因为「还没测过」就拦着不让装。
   */
  private installSourceRanking = new Map<DependencyId, string[]>();
  /** Last raw event per depId for re-emitting after async fetch. */
  private storedEvents = new Map<string, StoredEvent>();
  /**
   * 每一行依赖最近一次发出去的 DTO —— 一家几个程序时(#6335)要拿**各行最新的那份**折成这一家的,
   * 而事件是一行一行来的。
   */
  private lastStatuses = new Map<string, AgentInstallationStatus>();

  constructor(options?: { logger?: Logger }) {
    this.latestVersionService = new LatestVersionService({ logger: options?.logger });
    this.logger = options?.logger;
  }

  /**
   * Subscribe to a manager's onStatusUpdated events: enrich with latest-version
   * data and emit on the desktop channels. Called once per manager instance.
   */
  attach(manager: HostDependencyManager): void {
    manager.onStatusUpdated.subscribe((event: DependencyStatusUpdatedEvent) => {
      this.handleManagerEvent(event);
    });
  }

  /** Returns cached update info for a dep. null/false when unknown. */
  getUpdateInfo(id: DependencyId, installedVersion: string | null, registry?: string): UpdateInfo {
    const key = this.cacheKey(id, getDependencyDescriptor(id), registry);
    const latestVersion = this.latestVersionCache.get(key) ?? null;
    const updateAvailable =
      latestVersion !== null && installedVersion !== null
        ? isNewerVersion(installedVersion, latestVersion)
        : false;
    return { latestVersion, updateAvailable };
  }

  /**
   * Force a cache invalidation + re-fetch + re-emit for a single dependency.
   * Called by the controller's `refreshLatestVersion` RPC.
   */
  async refreshLatestVersion(id: DependencyId): Promise<void> {
    const descriptor = getDependencyDescriptor(id);
    if (!descriptor) return;

    // Invalidate cache so the next fetch goes to the network
    if (descriptor.updates?.kind === 'supported') {
      this.latestVersionService.invalidate(descriptor.updates.releaseSource);
    }
    this.clearDependencyCache(id);

    const storageKey = `local:${id}`;
    const registry = this.registryFor(
      descriptor,
      this.storedEvents.get(storageKey)?.raw.hostDependency,
    );
    await this.fetchLatestAndReemit(id, descriptor, registry);
    if (descriptor.updates?.kind === 'supported' && descriptor.updates.releaseSource.kind !== 'none'
      && !this.latestVersionCache.get(this.cacheKey(id, descriptor, registry))) {
      throw new Error(`Could not check the latest version of ${id}.`);
    }
  }

  /**
   * Fetch the version advertised by every concrete npm source shown in the install menu, and —
   * when the caller can say which machine the install would land on — whether that source
   * actually carries the platform build that machine needs.
   *
   * `target` is optional on purpose. Answering for the wrong machine is worse than not
   * answering, and a remote host's arch is not known in this process.
   */
  async fetchInstallSourceVersions(
    id: DependencyId,
    installOptions: InstallOption[],
    target?: InstallTarget,
  ): Promise<InstallSourceVersions> {
    const sources = new Map<string, string>();
    for (const option of installOptions) {
      if (option.registry && option.registryPackage) {
        sources.set(option.registry, option.registryPackage);
      }
    }

    // 这一趟顺手计时:谁先正确答出来,谁就是下一次安装的下载源(#6157)。测法见
    // `install-source-race.ts`(借 nrm 的做法)。❌ 不为选源另发一趟请求。
    const probes = await probeInstallSources([...sources.keys()], async (registry) => {
      const packageName = sources.get(registry)!;
      const [version, platformBuild] = await Promise.all([
        this.latestVersionService.fetchLatestVersion(
          { kind: 'npm', package: packageName },
          registry,
        ),
        target
          ? this.latestVersionService.probePlatformBuild(packageName, registry, target)
          : Promise.resolve('unknown' as const),
      ]);
      return { version, platformBuild };
    });
    this.installSourceRanking.set(id, rankInstallSources(probes));
    const entries = probes.map((p) => [p.registry, p.version, p.platformBuild] as const);

    const knownVersions = entries
      .map(([, version]) => parseVersion(version))
      .filter((version): version is semver.SemVer => version !== null);
    const newest = knownVersions.sort(semver.rcompare)[0] ?? null;
    const result: InstallSourceVersions = {};

    for (const [registry, version, platformBuild] of entries) {
      const parsed = parseVersion(version);
      result[registry] = {
        version,
        outdated: parsed !== null && newest !== null ? semver.lt(parsed, newest) : false,
        // Only a definite 'missing' is reported. 'unknown' stays absent so an offline check
        // never withholds a source that works.
        ...(platformBuild === 'missing' ? { platformBuildMissing: true } : {}),
      };
    }

    const descriptor = getDependencyDescriptor(id);
    const releaseSource =
      descriptor?.updates?.kind === 'supported' ? descriptor.updates.releaseSource : undefined;
    if (releaseSource?.kind === 'npm') {
      for (const [registry, version] of entries) {
        // Only cache a resolved version. Caching null would make handleManagerEvent — which
        // fetches only when the entry is `undefined` — treat one unreachable registry as a
        // final answer and never check that agent again for the life of the process.
        if (version !== null && sources.get(registry) === releaseSource.package) {
          this.latestVersionCache.set(this.cacheKey(id, descriptor, registry), version);
        }
      }
    }

    return result;
  }

  /**
   * 这一家该按什么顺序试下载源(#6157)。
   *
   * 读的是上一趟「查最新版本」的计时结果(面板一打开就发过)。还没测过就是空数组 ——
   * 调用方据此退回 descriptor 的推荐源,❌ 不在这里现测一趟把安装按住。
   */
  installSourceOrder(id: DependencyId): string[] {
    return this.installSourceRanking.get(id) ?? [];
  }

  /**
   * Enrich a HostDependency with latestVersion/updateAvailable for each installation,
   * gated by installationCanUpdate(source, strategyKind). Public so the controller and
   * payload builder can enrich manager snapshots on demand (e.g. for RPC reads).
   */
  enrichHostDependency(id: DependencyId, hostDep: HostDependency): HostDependency {
    const descriptor = getDependencyDescriptor(id);
    const registry = descriptor ? this.registryFor(descriptor, hostDep) : undefined;
    const latestVersion =
      this.latestVersionCache.get(this.cacheKey(id, descriptor, registry)) ?? null;
    return this.applyEnrichment(descriptor, hostDep, latestVersion);
  }

  private handleManagerEvent(event: DependencyStatusUpdatedEvent): void {
    const descriptor = getDependencyDescriptor(event.id);
    if (descriptor?.category !== 'agent') return;

    const storageKey = `local:${event.id}`;
    this.storedEvents.set(storageKey, { raw: event, installedVersion: event.state.version });

    const registry = this.registryFor(descriptor, event.hostDependency);
    const latestCached = this.latestVersionCache.get(
      this.cacheKey(event.id as DependencyId, descriptor, registry),
    );

    if (latestCached !== undefined) {
      // We have a cached latest version — enrich and emit immediately
      this.emitEnrichedEvent(event, descriptor, latestCached);
      return;
    }

    // Emit the raw event first (no update info yet), then kick off async fetch.
    //
    // The fetch runs even when the event carries no hostDependency. Its re-emit is discarded in
    // that case, but the fetch also populates latestVersionCache, which getUpdateInfo reads
    // directly — skipping it leaves that path with no data. Cache entries are keyed per registry,
    // so a fetch made before the selection is known lands under the default registry and does not
    // mask a later lookup for the selected one.
    this.emitEnrichedEvent(event, descriptor, null);

    void this.fetchLatestAndReemit(event.id as DependencyId, descriptor, registry);
  }

  private async fetchLatestAndReemit(
    id: DependencyId,
    descriptor: DependencyDescriptor,
    requestedRegistry?: string,
  ): Promise<void> {
    if (!descriptor.updates || descriptor.updates.kind !== 'supported') return;
    const { releaseSource } = descriptor.updates;
    if (releaseSource.kind === 'none') return;

    // Normalise up front. The staleness check below compares this against a fresh registryFor()
    // reading, and registryFor never yields a bare undefined for an npm source — so an
    // un-normalised argument would compare unequal to itself and silently drop the re-emit.
    // Today every caller already passes a registryFor() result; this keeps that from being a
    // rule the next caller has to know.
    const registry =
      requestedRegistry ?? (releaseSource.kind === 'npm' ? DEFAULT_NPM_REGISTRY_ID : undefined);

    const latestVersion = await this.latestVersionService.fetchLatestVersion(
      releaseSource,
      registry,
    );

    this.latestVersionCache.set(this.cacheKey(id, descriptor, registry), latestVersion);

    // Re-emit with enriched data using the latest stored event for this host+dep
    const storageKey = `local:${id}`;
    const stored = this.storedEvents.get(storageKey);
    if (!stored) return;

    // A user can switch registries while the previous request is in flight. Do not apply the
    // older source's result to the newer event; the newer request owns that re-emission.
    // Both sides are normalised registry ids, so this is the same test the two cache keys
    // performed — minus two registry lookups and two string concatenations.
    if (this.registryFor(descriptor, stored.raw.hostDependency) !== registry) return;

    this.emitEnrichedEvent(stored.raw, descriptor, latestVersion);
  }

  private emitEnrichedEvent(
    event: DependencyStatusUpdatedEvent,
    descriptor: DependencyDescriptor | undefined,
    latestVersion: string | null,
  ): void {
    const updateAvailable =
      latestVersion !== null && event.state.version !== null
        ? isNewerVersion(event.state.version, latestVersion)
        : false;

    const enrichedState: DependencyState = {
      ...event.state,
      latestVersion,
      updateAvailable,
    };

    const enrichedHostDep = event.hostDependency
      ? this.applyEnrichment(descriptor, event.hostDependency, latestVersion)
      : undefined;

    if (enrichedHostDep) {
      const dto = toAgentInstallationStatus(event.id, enrichedState, enrichedHostDep);
      this.lastStatuses.set(event.id, dto);
      // 渲染层按**插件**记状态:伴随程序那一行的变化要以属主那一家的合并读数发出去,
      // ❌ 不发一条 id 叫 `antigravity-cli` 的「插件」状态(#6335)。
      const pluginId = descriptor?.ownerId ?? event.id;
      const parts = agentProgramsOf(getPlugin(pluginId));
      const folded = parts.length > 1
        ? foldAgentPrograms(parts, (dependencyId) => this.lastStatuses.get(dependencyId))
        : dto;
      // 主程序那一行还没来过 = 这一家还没法说清,等它来(它来时会带上这一行)。
      if (folded) events.emit(agentInstallationStatusUpdatedChannel, folded);
    }
  }

  /**
   * Core enrichment: sets latestVersion and updateAvailable on each installation,
   * gating updateAvailable through installationCanUpdate so unknown+package-manager
   * installations never report an actionable update.
   */
  private applyEnrichment(
    descriptor: DependencyDescriptor | undefined,
    hostDep: HostDependency,
    latestVersion: string | null,
  ): HostDependency {
    const updates = descriptor?.updates;
    const strategyKind = updates?.kind === 'supported' ? updates.update.kind : ('none' as const);
    /**
     * 机器上本来就有的那份,「更新」= 咕咕装一份最新的并切过去(spec harness-install-panel)。
     * 所以只要咕咕在这台机器上装得了这一家,新版本就照实报出来 —— 界面上的「更新」接得住
     * (`resolveManagedUpdate` 的 install 分支)。
     *
     * ❌ 从前只认 `installationCanUpdate`(要求 manageable = 咕咕自己那份):owner 机器上 6 家
     * 全是自己装的,Pi / MiMo / OpenCode / Qwen 各落后几个版本,界面一个都没报(2026-09-22 实测)。
     */
    const canTakeOver =
      !!descriptor?.installCommands?.[toPlatform(process.platform)]?.some((o) => o.method === 'mise');

    const installations = hostDep.installations.map((inst): Installation => {
      if (inst.version === null) return { ...inst, latestVersion: null, updateAvailable: false };
      const rawDiff = latestVersion !== null ? isNewerVersion(inst.version, latestVersion) : false;
      const updateAvailable =
        rawDiff && (installationCanUpdate(inst, strategyKind) || canTakeOver);
      return { ...inst, latestVersion, updateAvailable };
    });
    return { ...hostDep, installations };
  }

  /**
   * Cache key for a dependency's latest-version entry. npm sources key per registry; every
   * other release source keys by id alone.
   *
   * Takes the descriptor rather than looking it up: this runs for every installation of every
   * agent on every status event, and the caller already holds the descriptor in all but one
   * case.
   */
  private cacheKey(
    id: DependencyId,
    descriptor: DependencyDescriptor | undefined,
    registry?: string,
  ): string {
    const releaseSource =
      descriptor?.updates?.kind === 'supported' ? descriptor.updates.releaseSource : undefined;
    if (releaseSource?.kind === 'npm') {
      return `${id}@${registry ?? DEFAULT_NPM_REGISTRY_ID}`;
    }
    return id;
  }

  /**
   * Which registry to ask for this dependency's latest version.
   *
   * An explicit npm source selection wins: it is the source the update will run from, and
   * product spec requires the check and the run to agree.
   *
   * Otherwise fall back to the registry the resolved binary was actually installed from. A
   * `pinned` selection is the normal shape for a copy installed outside the app, mirrors included
   * — and answering "official" there is how the update prompt silently disappears for the users
   * this feature exists for: fetchLatestVersion swallows the unreachable-registry error and
   * returns null, so there is no error, no prompt, and nothing to click.
   */
  private registryFor(
    descriptor: DependencyDescriptor,
    hostDep?: HostDependency,
  ): string | undefined {
    if (descriptor.updates?.kind !== 'supported') return undefined;
    if (descriptor.updates.releaseSource.kind !== 'npm') return undefined;
    // 用户明确选过下载源就用它 —— 与他选了哪一份副本无关。旧写法只认 `method` 选择,于是钉了
    // 某一份副本的用户,其"最新是什么"永远按官方源算,而执行更新时却用另一个源:正是
    // product spec「更新检查与更新执行使用同一个源」要禁的那种错位。#4271
    if (hostDep?.used.registry) return hostDep.used.registry;
    if (hostDep) {
      const active = resolveActiveInstallation(hostDep.installations, hostDep.used);
      if (active?.provenance.registry) return active.provenance.registry;
    }
    return DEFAULT_NPM_REGISTRY_ID;
  }

  private clearDependencyCache(id: DependencyId): void {
    const prefix = `${id}@`;
    for (const key of this.latestVersionCache.keys()) {
      if (key === id || key.startsWith(prefix)) this.latestVersionCache.delete(key);
    }
  }
}

export const agentUpdateService = new AgentUpdateService();
