import { Emitter, err, ok, type Result } from '@gugu/session-shared';
import type { IExecutionContext } from '../../exec/execution-context';
import { consoleLogger, type Logger } from '../../lib/logger';
import type { InstallMethod, InstallOption, InstallTarget, Platform } from '../capability';
import { resolveInstallOptions, pickInstallOption, toPlatform } from './install-options';
import type { HostDependencyLedger } from './ledger';
import { createInstallMethodDetector, type InstallMethodDetector } from './method-detection';
import {
  defaultProbeStatus,
  resolveAllCommandPaths,
  resolveCommandPath,
  resolveKnownPaths,
  resolveRealpath,
  runVersionProbe,
  VERSION_RE,
  versionLineOf,
  withProbeSwitches,
} from './probe';
import { isDownloadStageFailure, readHostDependency,
  type CustomTarget,
} from './types';
import type {
  DependencyCategory,
  DependencyDescriptor,
  DependencyId,
  DependencyInstallResult,
  DependencyProbeOptions,
  DependencyState,
  DependencyStatus,
  DependencyStatusUpdatedEvent,
  DependencyUninstallResult,
  DependencyUpdateResult,
  HostDependency,
  HostDependencySelection,
  InstallationReading,
  InstallCommandContext,
  InstallCommandError,
  Installation,
  InstallProgressReport,
  InstallRecord,
  ProbeResult,
  Provenance,
  SelectedSource,
} from './types';
import { resolveActiveInstallation, resolveSelectedSource } from './types';

/**
 * Runs an install or update command string (e.g. "brew install claude") through the
 * host's shell. Deliberately not part of IExecutionContext: install commands are full
 * shell lines run through the user's shell profile (typically in a PTY), with failures
 * classified into InstallCommandError instead of thrown.
 */
export type InstallCommandRunner = (
  command: string,
  context?: InstallCommandContext,
) => Promise<Result<void, InstallCommandError>>;
export type HostDependencyRunOptions = {
  run?: InstallCommandRunner;
  /** Registry id for a concrete package-manager source selection. */
  registry?: string;
  /**
   * 本次下载的候选源,**按测速排好**(最先正确答出版本的在前,#6157)。
   *
   * 第一条就是这次用的源;下载那一段失败(超时 / 校验不过)时换第二条**重试一次**,
   * 用户只看到进度继续。测速在应用层做(`install-source-race.ts`)—— 这一层不知道也不该知道
   * 「哪个源快」,它只负责按给定顺序试。
   *
   * 用户在「高级」里手动指定了源时调用方传 `registry`,这一项就不该出现:他指名要那个源,
   * ❌ 不许悄悄换成别的。
   */
  registries?: readonly string[];
  /** 中止这次安装。传到底会真的杀掉安装进程（#5719）。 */
  signal?: AbortSignal;
  /** 实时读数往哪儿报。不给就不量。 */
  onProgress?: (report: InstallProgressReport) => void;
};

function operationContext(
  option: InstallOption | undefined,
  operation: 'install' | 'update' | 'uninstall',
  options: HostDependencyRunOptions,
  selectedPath?: string,
): InstallCommandContext {
  return {
    ...(option?.target?.kind === 'mise' ? { mise: { target: option.target, operation, registry: options.registry ?? option.registry, selectedPath } } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
}

function runOperation(run: InstallCommandRunner, command: string, context: InstallCommandContext) {
  return Object.keys(context).length > 0 ? run(command, context) : run(command);
}

/** Methods that are non-PM origins — cannot be used for PM routing. */
const NON_PM_KINDS = new Set(['manual', 'version-manager', 'unknown']);

/** Returns true when a provenance kind is a real InstallMethod that can be PM-routed. */
function isRealInstallMethod(kind: Provenance['kind'] | null | undefined): kind is InstallMethod {
  return !!kind && !NON_PM_KINDS.has(kind);
}

/**
 * The registry a command actually forces, or null when it forces none.
 *
 * Only a command carrying `--registry=` decides where the bytes come from. A bare
 * `npm install -g <pkg>` — which is what the default-registry option runs — resolves through the
 * user's own npm config, and that config may itself point at a mirror. Recording "official" for
 * those would be a guess written down as a fact, so they record nothing instead.
 *
 * Reads the command that will run rather than the option's identity, so an option whose update
 * command differs from its install command is judged on what it does.
 */
function pinnedRegistryIn(command: string, registry: string | undefined): string | null {
  if (!registry) return null;
  return command.includes('--registry=') ? registry : null;
}

/**
 * 咕咕能不能管(更新 / 卸载)这一份。
 *
 * **第一道也是唯一一道门:这一份是不是咕咕自己装的。**
 *
 * 咕咕只维护自己装的那份(product spec)。用户机器上已有的副本照常被发现、
 * 可选、显示版本,但咕咕不动它们 —— 那与「咕咕不接管用户已有的副本:不改、不移、不删」是
 * 同一条线,更新别人的副本本身就是「改」。
 *
 * ❌ 曾经用 `isRealInstallMethod(provenance.kind)` 当判据,理由是「能不能认出是谁装的」与
 * 「能不能被升级」无关。技术上无关,**责任上是一件事**。放宽之后的真机后果(#4271,owner 机器):
 * 一份由独立安装器铺在 `~/.local/share/codex/<版本>/node_modules/` 的副本,因为 realpath 里
 * 有 `node_modules` 字样被判成 npm 装的,于是拿到了更新按钮;点下去咕咕跑 `npm install -g`,
 * npm 去的是**另一个** package root、撞上别人的文件、EEXIST。而报错还让用户「到更换来源里
 * 选那一份」—— 他选的就是那一份。
 *
 * 换成「是不是我装的」之后,这一整类推断就不存在了:落点是咕咕自己的目录、只有咕咕写,
 * 更新命令必然打在它身上。这是个咕咕**自己知道**的事实,不是对世界的猜测。
 */
function computeManageable(provenance: Provenance, descriptor: DependencyDescriptor): boolean {
  if (provenance.ours !== true) return false;

  const updates = descriptor.updates;
  const strategyKind = updates?.kind === 'supported' ? updates.update.kind : 'none';
  const uninstallKind = descriptor.uninstall?.kind ?? 'none';

  if (strategyKind === 'package-manager' || uninstallKind === 'package-manager') {
    return isRealInstallMethod(provenance.kind);
  }
  return false;
}

/**
 * 手动指定的那一行,把**同一个文件**在枚举那一轮里的来源抄过来(#6101)。
 *
 * 覆盖项(`id: 'path' | 'cli'`)是另起的一条记录,它自己那次探测只问了「这个路径上有没有
 * 能跑的东西」,答不出「谁装的」—— 于是恒为 `unknown`。真机后果(mac1 实测):下拉里明明
 * 写着 `npm v2.1.267 /opt/homebrew/bin/claude`,手动填**同一个路径**之后卡头变成
 * `Already on this machine v2.1.267 · Unknown` —— 用户以为自己填错了,或以为咕咕把这份副本降级了。
 *
 * realpath 相同就是同一个文件,而枚举那一轮已经答过这个问题了(还经过了安装记录回放)。
 * ⇒ 抄过来,❌ 不重新推断一次:同一个文件两套来源标签,本身就是 #6101 要消掉的东西。
 * 抄不到孪生行时原样不动 —— 那说明它真的不在 PATH 上,`unknown` 是如实的。
 */
function inheritTwinProvenance(
  installations: Installation[],
  descriptor: DependencyDescriptor,
): void {
  const isOverrideRow = (installation: Installation): boolean =>
    installation.id === 'path' || installation.id === 'cli';
  for (const override of installations) {
    if (!isOverrideRow(override)) continue;
    const twin = installations.find(
      (candidate) => !isOverrideRow(candidate) && candidate.realpath === override.realpath,
    );
    if (!twin) continue;
    override.provenance = twin.provenance;
    override.manageable = computeManageable(twin.provenance, descriptor);
  }
}

function resolveProbeStatus(resolvedPath: string | null, probe: ProbeResult, versionLine?: RegExp): DependencyStatus {
  // 口径只有一份,在 probe.ts。`resolvedPath` 与 `probe.path` 是同一个值(runVersionProbe
  // 就是把它写进 path 的),所以这里直接把探测结果交过去。
  return defaultProbeStatus(resolvedPath === probe.path ? probe : { ...probe, path: resolvedPath }, versionLine);
}

function extractVersion(probe: ProbeResult, versionLine?: RegExp): string | null {
  const raw = (probe.stdout || probe.stderr).trim();
  // 这一家自己那一行(`versionLineOf`);认不出就照旧读第一行。
  const line = versionLineOf(raw, versionLine) ?? raw.split('\n')[0]?.trim() ?? '';
  const m = VERSION_RE.exec(line);
  return m ? m[1] : line || null;
}

function dependencyStateFromProbeResult(
  descriptor: DependencyDescriptor,
  resolvedPath: string | null,
  probe: ProbeResult | null,
): DependencyState {
  let status: DependencyStatus;
  let version: string | null = null;

  if (probe === null) {
    status = resolvedPath !== null ? 'available' : 'missing';
  } else {
    status = resolveProbeStatus(resolvedPath, probe, descriptor.versionLine);
  }

  if (status === 'available' && probe) {
    version = extractVersion(probe, descriptor.versionLine);
  }

  return {
    id: descriptor.id,
    category: descriptor.category,
    status,
    version,
    path: resolvedPath,
    checkedAt: Date.now(),
    error: status === 'error' ? probe?.stderr?.trim() || 'Unknown error' : undefined,
  };
}

export type HostDependencyManagerOptions = {
  /**
   * Runs install / update command strings.
   * Required when `install()` or `update()` will be called.
   */
  runInstallCommand?: InstallCommandRunner;
  connectionId?: string;
  platform?: Platform;
  /**
   * 这台机器那**一本账**(#6101)。给了它就等于给齐了下面那三个回调 —— 它们是同一件事的
   * 逐个写法,留着是因为桌面端主进程本来就是账本的属主、直接接上自己的 store 更直白。
   *
   * ⚠️ 两者都给时以 `ledger` 为准:一个上下文只能读一本账,读两本就回到了 #6101 那个「同一台
   * 机器两份读数」的原点。
   */
  ledger?: HostDependencyLedger;
  /**
   * Reads the user's persisted installation selection for a dependency on this host.
   * Persistence is owned entirely by the application layer; the manager only asks
   * for the current preference when building host-scoped installation state.
   */
  getSelection?: (depId: DependencyId) => Promise<HostDependencySelection | null>;
  /**
   * Reads what the app remembers about the install it last performed for this dependency on
   * this host. Same division of labour as `getSelection`: the manager decides what to record,
   * the application layer decides where it lives.
   */
  getInstallRecord?: (depId: DependencyId) => Promise<InstallRecord | null>;
  /** Persists (or clears, with null) that record. */
  setInstallRecord?: (depId: DependencyId, record: InstallRecord | null) => Promise<void>;
  logger?: Logger;
  /** All dependency descriptors to manage. Injected by the application layer (e.g. desktop registry). */
  dependencies?: DependencyDescriptor[];
  /** Lookup function for a single descriptor by id. Defaults to searching `dependencies`. */
  getDependencyDescriptor?: (id: string) => DependencyDescriptor | undefined;
  /**
   * Override the install-method detector. Defaults to createInstallMethodDetector(ctx, platform).
   * Inject a stub in tests to avoid live brew/npm queries.
   */
  installMethodDetector?: InstallMethodDetector;
  /**
   * 这一份依赖**真正跑起来时**的环境(#5702)。版本探测每次都用它,所以「面板上显示的
   * 装没装 / 什么版本」和用户按下开始时是同一个环境里的答案。
   *
   * 只对答得上来的依赖给(桌面端给的是 agent 那一类,来自宿主算好的运行上下文);
   * 返回 undefined 就落回执行上下文自己那份通用环境。
   */
  resolveProbeEnv?: (
    descriptor: DependencyDescriptor
  ) => Promise<Record<string, string> | undefined>;
  /**
   * 不执行就读出「咕咕装的这一份是什么版本」—— 只给 `skipVersionProbe` 的家用(#6335)。
   *
   * 那些家执行一次就有副作用(ACP 服务跑起来就是起一个服务),所以版本不能跑出来;
   * 咕咕自己装的那份,版本在装之前就钉死并写进了启动器(桌面端读那一行发行标记)。
   * 读不出来(不是咕咕的启动器、用户自己装的)就是 null —— ❌ 不猜一个。
   */
  readManagedVersion?: (path: string) => Promise<string | null>;
};

/**
 * Portable dependency manager for a single host.
 * Responsible only for probing installed versions and running install/update/uninstall
 * commands. It does NOT fetch latest published versions or compute updateAvailable — that
 * is the responsibility of the application layer (e.g. AgentUpdateService in desktop).
 * Desktop composes this with PTY install-runner, KV-backed store, and event bridge.
 */
export class HostDependencyManager<Ctx extends IExecutionContext = IExecutionContext> {
  private state = new Map<DependencyId, DependencyState>();
  /** Host-scoped installation data, populated for every dependency during probe(). */
  private hostState = new Map<DependencyId, HostDependency>();
  /**
   * Registry pinned by an install/update command that just ran, waiting to be attributed to a
   * concrete binary. Set before the re-probe and consumed by the enumeration it triggers —
   * which is the only place where the resulting realpath and version are both known.
   * A null value means the command pinned nothing, so any earlier record must be dropped.
   */
  private pendingInstall = new Map<
    DependencyId,
    {
      method: InstallMethod | undefined;
      registry: string | null;
      target?: InstallTarget;
      targetRealpaths?: string[];
    }
  >();
  private lastInstallRecords = new Map<DependencyId, InstallRecord | null>();
  /** 上一次报出去的读数,用来判「变了没有」。见 `logReading`。 */
  private lastReadings = new Map<DependencyId, InstallationReading>();

  private readonly ctx: Ctx;
  private readonly runInstallCommand: InstallCommandRunner;
  private readonly connectionId: string | undefined;
  private readonly getSelection: (depId: DependencyId) => Promise<HostDependencySelection | null>;
  /** 每个依赖最近一次开始构建 HostDependency 的序号 —— 只有最新那一趟能落盘和广播。 */
  private readonly hostBuildGeneration = new Map<DependencyId, number>();
  private readonly getInstallRecord: (depId: DependencyId) => Promise<InstallRecord | null>;
  private readonly getLastCustom: (depId: DependencyId) => Promise<CustomTarget | null>;
  private readonly setInstallRecord: (
    depId: DependencyId,
    record: InstallRecord | null,
  ) => Promise<void>;
  private readonly logger: Logger;
  private readonly _dependencies: DependencyDescriptor[];
  private readonly _getDependencyDescriptor: (id: string) => DependencyDescriptor | undefined;
  private readonly detector: InstallMethodDetector;
  private readonly resolveProbeEnv: (
    descriptor: DependencyDescriptor,
  ) => Promise<Record<string, string> | undefined>;
  private readonly readManagedVersion: (path: string) => Promise<string | null>;
  /** Platform of the target machine. Defaults to process.platform; SSH callers pass the remote platform. */
  readonly platform: Platform;

  /** Fired after every state update. */
  readonly onStatusUpdated = new Emitter<DependencyStatusUpdatedEvent>();

  /**
   * Fired when a binary's resolved-path cache should be invalidated (after
   * install / update / setSelection). Desktop bridges this to clearResolvedPathCache().
   */
  readonly onExecutableInvalidated = new Emitter<{ id: DependencyId }>();

  constructor(ctx: Ctx, options: HostDependencyManagerOptions = {}) {
    this.ctx = ctx;
    this.connectionId = options.connectionId;
    this.platform = options.platform ?? toPlatform(process.platform);
    const ledger = options.ledger;
    this.getSelection =
      ledger?.getSelection.bind(ledger) ?? options.getSelection ?? (() => Promise.resolve(null));
    this.getLastCustom =
      ledger?.getLastCustom?.bind(ledger) ?? (() => Promise.resolve(null));
    this.getInstallRecord =
      ledger?.getInstallRecord.bind(ledger) ??
      options.getInstallRecord ??
      (() => Promise.resolve(null));
    this.setInstallRecord =
      ledger?.setInstallRecord.bind(ledger) ?? options.setInstallRecord ?? (() => Promise.resolve());
    this.logger = options.logger ?? consoleLogger;
    this._dependencies = options.dependencies ?? [];
    this._getDependencyDescriptor =
      options.getDependencyDescriptor ?? ((id) => this._dependencies.find((d) => d.id === id));
    this.detector =
      options.installMethodDetector ?? createInstallMethodDetector(this.ctx, this.platform);
    const resolveBaseProbeEnv = options.resolveProbeEnv ?? (() => Promise.resolve(undefined));
    // descriptor 自带的开关叠在最上面:本机主进程与 worker 的每一次探测同一处施加(见 `withProbeSwitches`)。
    this.resolveProbeEnv = async (descriptor) =>
      withProbeSwitches(this.ctx, await resolveBaseProbeEnv(descriptor), descriptor.probeEnv);
    const readManagedVersion = options.readManagedVersion;
    // 读挂了按「读不出」处理:版本是锦上添花,❌ 不许让一次读文件失败把整条探测拖垮。
    this.readManagedVersion = readManagedVersion
      ? (path) => readManagedVersion(path).catch(() => null)
      : () => Promise.resolve(null);
    this.runInstallCommand =
      options.runInstallCommand ??
      (() =>
        Promise.resolve(
          err({
            type: 'command-failed' as const,
            message: 'No install runner configured',
            output: '',
            exitCode: undefined,
          }),
        ));
  }

  /** Kick off background probing for all dependencies. Returns immediately. */
  initialize(): void {
    void this.probeAll();
  }

  getAll(): Map<DependencyId, DependencyState> {
    return new Map(this.state);
  }

  get(id: DependencyId): DependencyState | undefined {
    return this.state.get(id);
  }

  /**
   * Check whether the cached status still agrees with a fresh PATH lookup.
   *
   * Version probing is deliberately not repeated here; this is only the cheap
   * invalidation guard used before returning cached agent rows. A missing
   * executable must invalidate an old `available` state, and a newly installed
   * executable must invalidate an old `missing` state.
   */
  async isPathResolutionConsistent(id: DependencyId): Promise<boolean> {
    const state = this.state.get(id);
    const descriptor = this._getDependencyDescriptor(id);
    if (!state || !descriptor) return false;
    const resolvedPath = await this.resolveFirstPath(descriptor);
    return (resolvedPath !== null) === (state.status !== 'missing');
  }

  /** Returns the host-scoped installation data for a dependency, if available. */
  getHostDependency(id: DependencyId): HostDependency | undefined {
    return this.hostState.get(id);
  }

  /**
   * Two-phase probe for a single dependency:
   *   1. Resolve path (fast, ~5ms) — fires onStatusUpdated immediately.
   *   2. Run version probe (slow, up to 10s) — fires a second update on completion.
   *
   * Also builds a HostDependency with per-installation status (enumerated via
   * which -a + path/cli overrides).
   *
   * Note: emitted state does not carry latestVersion/updateAvailable — those are
   * filled in by the application layer (AgentUpdateService) after receiving this event.
   */
  async probe(id: DependencyId, options: { waitForInstallations?: boolean } = {}): Promise<DependencyState> {
    const descriptor = this._getDependencyDescriptor(id);
    if (!descriptor) {
      throw new Error(`Unknown dependency id: ${id}`);
    }

    // Phase 1: path resolution
    const resolvedPath = await this.resolveFirstPath(descriptor);
    const pathState = dependencyStateFromProbeResult(descriptor, resolvedPath, null);
    this.updateState(pathState);

    if (pathState.status === 'missing') {
      await this.buildHostDependencyAfterProbe(id, descriptor, null, null, options.waitForInstallations);
      return pathState;
    }
    if (descriptor.skipVersionProbe) {
      // 不执行它;咕咕自己装的那份,版本读启动器上写下的那一行(`readManagedVersion`)。
      const recorded = resolvedPath ? await this.readManagedVersion(resolvedPath) : null;
      const state = recorded ? { ...pathState, version: recorded } : pathState;
      if (recorded) this.updateState(state);
      await this.buildHostDependencyAfterProbe(id, descriptor, recorded ? state : null, null, options.waitForInstallations);
      return state;
    }

    // Phase 2: version probe
    const versionArgs = descriptor.versionArgs ?? ['--version'];
    // 量它的时候用它真跑起来时的那份环境(#5702)。
    const probeEnv = await this.resolveProbeEnv(descriptor);
    const probeResult = await runVersionProbe(
      descriptor.commands[0] ?? id,
      resolvedPath,
      versionArgs,
      this.ctx,
      { env: probeEnv },
    );
    const fullState = dependencyStateFromProbeResult(descriptor, resolvedPath, probeResult);
    this.updateState(fullState);

    // Phase 3: build HostDependency state.
    await this.buildHostDependencyAfterProbe(id, descriptor, fullState, probeResult, options.waitForInstallations);

    return fullState;
  }

  private async buildHostDependencyAfterProbe(
    id: DependencyId,
    descriptor: DependencyDescriptor,
    fullState: DependencyState | null,
    probeResult: ProbeResult | null,
    waitForInstallations = false,
  ): Promise<void> {
    if (waitForInstallations || descriptor.category === 'core' || this.pendingInstall.has(id)) {
      await this.buildAndStoreHostDependency(id, descriptor, fullState, probeResult);
      return;
    }

    // Preserve the existing fast return path for agent probes; installation enumeration
    // can run slower package-manager provenance checks in the background.
    void this.buildAndStoreHostDependency(id, descriptor, fullState, probeResult);
  }

  /**
   * Enumerate all installed copies of a dependency binary by running `which -a`
   * (or `where` on Windows) for all configured command names.
   *
   * Each discovered path is:
   *   1. realpathd to the canonical path (following symlinks)
   *   2. Deduplicated by realpath
   *   3. Marked isActive = true for the first PATH hit overall
   *   4. Probed for version
   *   5. Classified by the provenance detector
   *   6. Assessed for manageability
   *
   * The primary binary name (`descriptor.commands[0]`) is used for `which -a`;
   * additional command names are tried only if the first produces no results, to
   * handle renamed binaries across versions.
   */
  private async enumerateInstallations(
    id: DependencyId,
    descriptor: DependencyDescriptor,
    fullState: DependencyState | null,
  ): Promise<Installation[]> {
    const installations: Installation[] = [];
    const seenRealpaths = new Set<string>();

    // Try each command in order; stop once we get PATH hits to avoid mixing
    // different binary names (e.g., claude-code vs claude).
    const probeEnv = await this.resolveProbeEnv(descriptor);
    let allPaths: string[] = [];
    for (const command of descriptor.commands) {
      allPaths = await resolveAllCommandPaths(command, this.ctx, this.platform, probeEnv);
      if (allPaths.length > 0) break;
    }
    if (allPaths.length === 0) {
      allPaths = await resolveKnownPaths(descriptor.knownPaths?.[this.platform] ?? [], this.ctx, this.platform, probeEnv);
    }

    const pending = this.pendingInstall.get(id);
    const targetPaths = pending?.target && this.detector.locateTarget
      ? await this.detector.locateTarget(pending.target, descriptor.commands)
      : [];
    if (pending) {
      pending.targetRealpaths = await Promise.all(
        targetPaths.map((pathEntry) => resolveRealpath(pathEntry, this.ctx, this.platform)),
      );
    }
    const discovered = [
      ...allPaths.map((pathEntry) => ({ pathEntry, managed: false })),
      ...targetPaths.map((pathEntry) => ({ pathEntry, managed: true })),
    ];
    const primaryCommand = descriptor.commands[0] ?? descriptor.id;
    const versionArgs = descriptor.versionArgs ?? ['--version'];

    for (let i = 0; i < discovered.length; i++) {
      const { pathEntry, managed } = discovered[i]!;

      const realpath = await resolveRealpath(pathEntry, this.ctx, this.platform);

      if (seenRealpaths.has(realpath)) continue;
      seenRealpaths.add(realpath);

      const isActive = !managed && i === 0;
      const provenance = await this.detector.detect(realpath);
      const manageable = computeManageable(provenance, descriptor);

      // For the active (first) installation, reuse the already-computed fullState
      // to avoid a redundant version probe.
      let version: string | null = null;
      let status: DependencyStatus = 'available';

      if (isActive && fullState) {
        version = fullState.version;
        status = fullState.status;
      } else if (!descriptor.skipVersionProbe) {
        const probe = await runVersionProbe(primaryCommand, pathEntry, versionArgs, this.ctx, {
          env: await this.resolveProbeEnv(descriptor),
        });
        status = resolveProbeStatus(pathEntry, probe, descriptor.versionLine);
        if (status === 'available') version = extractVersion(probe, descriptor.versionLine);
      } else {
        version = await this.readManagedVersion(realpath);
      }

      installations.push({
        id: realpath,
        realpath,
        pathEntry: managed ? null : pathEntry,
        isActive,
        manageable,
        provenance,
        status,
        version,
        latestVersion: null,
        updateAvailable: false,
      });
    }

    return installations;
  }

  /**
   * Builds and stores a HostDependency.
   *
   * Enumerates all discovered installations via `which -a`, classifies each by
   * provenance, and appends any path/cli override installations from the persisted
   * selection. The `used` source is read from the KV store; missing → auto.
   *
   * latestVersion/updateAvailable are always null/false here; the application
   * layer enriches them after receiving the emitted event.
   */
  private async buildAndStoreHostDependency(
    id: DependencyId,
    descriptor: DependencyDescriptor,
    fullState: DependencyState | null,
    _probeResult: ProbeResult | null,
  ): Promise<void> {
    const hostId = this.connectionId ?? 'local';
    // 后发的那一趟说了算。选择读在开头,列副本要跑每一份的 --version(秒级),连着切两次来源时
    // 先发的那一趟可能最后才回来 —— 不拦它,它会把「在用」写回旧的选择再广播出去
    // (owner 2026-09-22 真机:点回「咕咕管理」,已存进去了,面板却停在「本机找到的」)。
    const generation = (this.hostBuildGeneration.get(id) ?? 0) + 1;
    this.hostBuildGeneration.set(id, generation);
    const selection = await this.getSelection(id);
    const used: SelectedSource = resolveSelectedSource(selection);

    // Enumerate all discovered installations
    const installations = await this.enumerateInstallations(id, descriptor, fullState);

    // Pinned override: include the authoritative binary even when it is not on PATH.
    if (
      selection?.kind === 'pinned' &&
      !installations.some((installation) => installation.realpath === selection.realpath)
    ) {
      installations.push(await this.probePinnedSource(descriptor, selection.realpath));
    }

    // Path override: probe when explicitly selected or previously saved
    if (selection?.kind === 'path') {
      installations.push(await this.probeOverrideSource(descriptor, 'path', selection.path));
    }

    // CLI override: probe when explicitly selected or previously saved
    if (selection?.kind === 'cli') {
      installations.push(await this.probeOverrideSource(descriptor, 'cli', selection.command));
    }

    // 没选中自定义路径时,上一次指定的那条也照样探一遍 —— 面板上「自定义路径」那一行要能显示它、
    // 点一下切回去(owner 2026-09-22)。它不是 PATH 上的,`isActive` 为 false,不影响「自动」选谁。
    if (selection?.kind !== 'path' && selection?.kind !== 'cli') {
      const last = await this.getLastCustom(id);
      if (last?.kind === 'path' && last.path) {
        installations.push(await this.probeOverrideSource(descriptor, 'path', last.path));
      } else if (last?.kind === 'cli' && last.command) {
        installations.push(await this.probeOverrideSource(descriptor, 'cli', last.command));
      }
    }

    // After the override entries are in, so an off-PATH pinned copy is eligible too. That copy is
    // the whole point of the record: a mirror install the user then pinned is exactly the case
    // where falling back to the official registry makes the update prompt disappear.
    await this.applyInstallRecord(id, installations, descriptor);
    // 记录回放之后再抄 —— 这样手动指定那一行连「咕咕装的」也一并抄得到。
    inheritTwinProvenance(installations, descriptor);

    const hostDependency: HostDependency = {
      hostId,
      dependencyId: id,
      installations,
      used,
    };

    // 期间又起了一趟更新的 —— 这一趟的读数已经过时,交给后发的那趟去存、去广播。
    if (this.hostBuildGeneration.get(id) !== generation) return;
    this.hostState.set(id, hostDependency);
    this.logReading(id, hostDependency);
    const currentState = this.state.get(id);
    if (!currentState) return;
    this.onStatusUpdated.emit({
      id,
      state: currentState,
      connectionId: this.connectionId,
      hostDependency,
    });
  }

  /**
   * 安装 / 更新 / 卸载各落三行:起、成、败(#6101)。
   *
   * 一律 `warn`:这三件事是**用户按出来的、罕见的、会改变磁盘的**动作(一次托管安装 208MB),
   * 而会话页这半边的 logger 默认只落 warn 及以上(见 `logReading` 上方那段)。装失败之后
   * 用户走开一会儿回来,界面上那条 toast 早没了 —— 日志里必须留着他和支持人员唯一能拿到的证据。
   *
   * ❌ 不打命令输出:那可能有几屏,而且里头可能有 registry token 一类的东西。失败原因用
   * 分类器给的 `type`(它本来就是给人读的那一层)。
   */
  private logOperation(
    operation: 'install' | 'update' | 'uninstall',
    /** `retry` = 下载那一段失败之后换源再试(#6157)。 */
    phase: 'started' | 'finished' | 'failed' | 'retry',
    id: DependencyId,
    fields: Record<string, unknown> = {},
  ): void {
    this.logger.warn(`[HostDependencyManager] ${operation} ${phase}`, {
      scope: 'host-dependency',
      host: this.connectionId ?? 'local',
      id,
      operation,
      phase,
      ...fields,
    });
  }

  /**
   * 每一次探测都把**读数**落一行(#6101)。
   *
   * 为什么非有不可:mac1 上整场跑完(两次 208MB 安装 + 三次失败 + 几十次探测),日志里关于
   * 装没装一个字都没有 —— 用户和支持人员事后拿不到任何证据,而「同一台机器三处给同一读数」
   * 这件事没有日志就根本无法核。
   *
   * 分级按 #4320 那条已经踩过的线:会话页这半边的 logger 默认级别是 `warn`(`resolveLogLevel`
   * 没有 `GUGU_SESSION_LOG_LEVEL` / `--debug-logs` 就是 warn),`info` 默认不落盘。
   *   · 逐次探测 `info` —— 一轮几十行,提到 warn 就把这条通道变成噪音;
   *   · **读数变了一行 `warn`** —— 默认级别下也一定落盘。「装好了 / 跑不起来了 / 你选的那份没了」
   *     正是事后要回答的那件事,而它天然稀疏。
   * ⇒ `host` 字段带上是本机还是哪条连接,三处(主进程 / worker / SSH)各自落一行,逐行可核。
   */
  private logReading(id: DependencyId, hostDependency: HostDependency): void {
    const reading = readHostDependency(hostDependency);
    const active = resolveActiveInstallation(hostDependency.installations, hostDependency.used);
    const fields = {
      scope: 'host-dependency',
      host: hostDependency.hostId,
      id,
      reading,
      used: hostDependency.used.kind,
      version: active?.version ?? null,
      path: active?.pathEntry ?? active?.realpath ?? null,
      provenance: active?.provenance.kind ?? null,
      ours: active?.provenance.ours === true,
      manageable: active?.manageable === true,
      copies: hostDependency.installations.length,
    };
    const previous = this.lastReadings.get(id);
    this.lastReadings.set(id, reading);
    if (previous !== undefined && previous !== reading) {
      this.logger.warn('[HostDependencyManager] reading changed', { ...fields, previous });
      return;
    }
    this.logger.info('[HostDependencyManager] reading', fields);
  }

  /**
   * Settles which installation, if any, carries a known source registry.
   *
   * Two directions. After an install or update the manager knows what the command pinned but not
   * yet which binary it produced, so the pending entry is spent here — where the realpath and
   * version that just landed are both in hand — and written down. Every other probe reads that
   * record back and replays it onto the matching installation.
   *
   * **「对得上」只看路径。**(#6101)
   *
   * ❌ 曾经还要求版本一字不差。理由当时写的是「被人从外面覆盖过就对不上」—— 但那条判据把
   * **最常见的一件事**判成了「不是咕咕装的」:claude 自带 auto-updater,它就地把自己升上去,
   * 路径一个字没变、版本变了 ⇒ 记录失配 ⇒ `ours` 掉回 false ⇒ 更新入口当场消失,而那一份
   * 确确实实是咕咕装的、也确确实实只有咕咕会去动它。版本会变是二进制的常态,不是它换了主人
   * 的证据;而**落点**是咕咕自己选的,那才是「这份归我」的凭据。
   *
   * ⇒ 版本不再是判据,只是**读数**:以这一轮探测为准回填,记录跟着更新。
   */
  private async applyInstallRecord(
    id: DependencyId,
    installations: Installation[],
    descriptor: DependencyDescriptor,
  ): Promise<void> {
    const pending = this.pendingInstall.get(id);
    if (pending !== undefined) {
      this.pendingInstall.delete(id);
      // Attribute only to a package-manager target or a detector-confirmed installation. A PATH
      // winner, and especially an unknown/inferred copy, is not evidence that this command wrote it.
      const candidates = pending.method
        ? installations.filter(
            (i) =>
              i.provenance.kind === pending.method &&
              i.provenance.confidence === 'confirmed',
          )
        : [];
      const targetCandidates = pending.targetRealpaths?.length
        ? installations.filter((i) => pending.targetRealpaths!.includes(i.realpath))
        : [];
      const installed = pending.target
        ? targetCandidates.find((i) => i.status === 'available')
        : candidates.find((i) => i.isActive) ?? candidates[0];
      const record: InstallRecord | null =
        installed && (pending.method !== undefined || pending.registry !== null)
          ? {
              ...(pending.method ? { method: pending.method } : {}),
              ...(pending.registry !== null ? { registry: pending.registry } : {}),
              realpath: installed.realpath,
              version: installed.version,
            }
          : null;
      await this.setInstallRecord(id, record);
      this.lastInstallRecords.set(id, record);
      if (record && installed) {
        installed.provenance = {
          ...installed.provenance,
          // 这一份是咕咕刚装的 —— 记录就是证据,不需要再去推断。
          ours: true,
          ...(pending.method
            ? { kind: pending.method, confidence: 'confirmed' as const }
            : {}),
          ...(pending.registry !== null ? { registry: pending.registry } : {}),
        };
        installed.manageable = computeManageable(installed.provenance, descriptor);
      }
      return;
    }

    const record = await this.getInstallRecord(id);
    if (!record) return;
    const match = installations.find((i) => i.realpath === record.realpath);
    if (!match) return;

    match.provenance = {
      ...match.provenance,
      // 记录指着这个落点 → 就是咕咕装的那一份。版本对不对得上不参与判定(见上)。
      ours: true,
      ...(record.method ? { kind: record.method, confidence: 'confirmed' as const } : {}),
      ...(record.registry ? { registry: record.registry } : {}),
    };
    match.manageable = computeManageable(match.provenance, descriptor);

    if (match.version === record.version) return;
    // 版本动了就把记录改成这一轮量到的值 —— 记录从此写的是「我们这份现在是什么版本」,
    // ❌ 不留一个装完那天的旧数字当事实。
    try {
      await this.setInstallRecord(id, { ...record, version: match.version });
    } catch (error) {
      // 写不了账的上下文(worker / 远端拿到的是副本)照旧把 `ours` 报对 —— 回填是属主的活,
      // 它下一轮探测就会写。❌ 不静默:哪一侧写不动、为什么,要看得见。
      this.logger.warn('[HostDependencyManager] could not refresh the install record version', {
        id,
        realpath: record.realpath,
        from: record.version,
        to: match.version,
        error: String(error),
      });
    }
  }

  private async probePinnedSource(
    descriptor: DependencyDescriptor,
    pinnedRealpath: string,
  ): Promise<Installation> {
    const resolvedPinnedPath = await resolveCommandPath(pinnedRealpath, this.ctx, this.platform, await this.resolveProbeEnv(descriptor));
    if (!resolvedPinnedPath) {
      return {
        id: pinnedRealpath,
        realpath: pinnedRealpath,
        pathEntry: null,
        isActive: false,
        manageable: false,
        provenance: { kind: 'unknown', confidence: 'inferred' },
        status: 'missing',
        version: null,
        latestVersion: null,
        updateAvailable: false,
      };
    }

    const canonicalRealpath = await resolveRealpath(resolvedPinnedPath, this.ctx, this.platform);
    const versionArgs = descriptor.versionArgs ?? ['--version'];
    const probe = descriptor.skipVersionProbe
      ? null
      : await runVersionProbe(resolvedPinnedPath, resolvedPinnedPath, versionArgs, this.ctx, {
          env: await this.resolveProbeEnv(descriptor),
        });
    const state = dependencyStateFromProbeResult(descriptor, resolvedPinnedPath, probe);
    const version = descriptor.skipVersionProbe
      ? await this.readManagedVersion(canonicalRealpath)
      : state.version;

    return {
      id: canonicalRealpath,
      realpath: canonicalRealpath,
      pathEntry: null,
      isActive: false,
      manageable: false,
      provenance: { kind: 'unknown', confidence: 'inferred' },
      status: state.status,
      version,
      latestVersion: null,
      updateAvailable: false,
    };
  }

  /**
   * Probe a single path or cli override value without persisting or emitting any events.
   * Used both internally by buildAndStoreHostDependency and publicly by probeOverride.
   *
   * Override installations use fixed ids ('path'/'cli') to preserve backward compatibility
   * with lookups by sourceKey('path'|'cli').
   */
  private async probeOverrideSource(
    descriptor: DependencyDescriptor,
    kind: 'path' | 'cli',
    value: string,
  ): Promise<Installation> {
    const versionArgs = descriptor.versionArgs ?? ['--version'];

    if (kind === 'path') {
      const pathExists = await resolveCommandPath(value, this.ctx, this.platform, await this.resolveProbeEnv(descriptor));
      if (pathExists) {
        const realpath = await resolveRealpath(pathExists, this.ctx, this.platform);
        const pathProbe = await runVersionProbe(value, value, versionArgs, this.ctx, {
          env: await this.resolveProbeEnv(descriptor),
        });
        const status = dependencyStateFromProbeResult(descriptor, pathExists, pathProbe).status;
        return {
          id: 'path',
          realpath,
          pathEntry: value,
          isActive: false,
          manageable: false,
          provenance: { kind: 'unknown', confidence: 'inferred' },
          status,
          version: status === 'available' ? extractVersion(pathProbe, descriptor.versionLine) : null,
          latestVersion: null,
          updateAvailable: false,
        };
      }
      return {
        id: 'path',
        realpath: value,
        pathEntry: value,
        isActive: false,
        manageable: false,
        provenance: { kind: 'unknown', confidence: 'inferred' },
        status: 'missing',
        version: null,
        latestVersion: null,
        updateAvailable: false,
      };
    }

    // cli
    const cliPath = await resolveCommandPath(value, this.ctx, this.platform, await this.resolveProbeEnv(descriptor));
    if (cliPath) {
      const realpath = await resolveRealpath(cliPath, this.ctx, this.platform);
      const cliProbe = await runVersionProbe(value, cliPath, versionArgs, this.ctx, {
        env: await this.resolveProbeEnv(descriptor),
      });
      const status = dependencyStateFromProbeResult(descriptor, cliPath, cliProbe).status;
      return {
        id: 'cli',
        realpath,
        pathEntry: value,
        isActive: false,
        manageable: false,
        provenance: { kind: 'unknown', confidence: 'inferred' },
        status,
        version: status === 'available' ? extractVersion(cliProbe, descriptor.versionLine) : null,
        latestVersion: null,
        updateAvailable: false,
      };
    }
    return {
      id: 'cli',
      realpath: value,
      pathEntry: value,
      isActive: false,
      manageable: false,
      provenance: { kind: 'unknown', confidence: 'inferred' },
      status: 'missing',
      version: null,
      latestVersion: null,
      updateAvailable: false,
    };
  }

  /**
   * Dry-run probe of a path or cli override value.
   * Does NOT persist any selection, mutate hostState, or emit onStatusUpdated.
   * Returns null when selection is empty.
   */
  async probeOverride(
    id: DependencyId,
    selection: { path?: string; cli?: string },
  ): Promise<Installation | null> {
    const descriptor = this._getDependencyDescriptor(id);
    if (!descriptor) throw new Error(`Unknown dependency id: ${id}`);
    if (selection.path) return this.probeOverrideSource(descriptor, 'path', selection.path);
    if (selection.cli) return this.probeOverrideSource(descriptor, 'cli', selection.cli);
    return null;
  }

  /**
   * 「要动哪一份 / 从哪儿下载 / 这一份归不归咕咕管」—— 一次算出,`update()` 与 `uninstall()`
   * 共用同一个答案。
   *
   * ❌ 别再让两支各写一份:这一段曾经逐字重复,而 #4271 正是「闸只写在一支里」酿成的 ——
   *    `uninstall()` 的注释里一直写着这道闸、代码里却没有,于是选中用户自己的 Homebrew
   *    副本再点卸载,咕咕跑 `brew uninstall` 把用户亲手装的东西删了。闸和路由同源,才不会漂。
   */
  private async resolveOperationRouting(
    id: DependencyId,
    method: InstallMethod | undefined,
    options: HostDependencyRunOptions,
  ): Promise<{
    /** 要动的就是这一份 —— 基线、落点、事后校验三处共用它,各自解析一遍正是同一屏三个答案的来路。 */
    targetPath: string | null;
    /** true = 这一份不归咕咕管。调用方必须在跑任何命令之前退出。 */
    blocked: boolean;
    effectiveMethod: InstallMethod | null | undefined;
    effectiveRegistry: string | undefined;
  }> {
    // 「在用的那一份」由用户的选择决定,不由 PATH 的先后决定。#4271
    const hostDep = this.hostState.get(id);
    const selection: SelectedSource = resolveSelectedSource(await this.getSelection(id));
    // 界面上「更新 / 卸载」只挂在「咕咕管理」那一行(spec harness-install-panel):它们动的**永远是咕咕
    // 自己装的那份**,与此刻在用哪一份无关。❌ 从前按「在用的那一份」取目标 —— 在用的是用户自己的
    // Homebrew 副本时,点咕咕那份的「卸载」,目标算成了 Homebrew 那份,被下面的闸拦下,界面报
    // 「卸载 Codex 失败」(owner 2026-09-23 实测)。咕咕那份不在时才退回按选择取,那份若不归咕咕管照样被闸拦。
    const ours = hostDep?.installations.find((i) => i.provenance.ours === true && i.manageable);
    const activeInst =
      ours ?? (hostDep ? resolveActiveInstallation(hostDep.installations, selection) : undefined);
    const targetPath = activeInst?.pathEntry ?? activeInst?.realpath ?? null;

    // 「不归咕咕管的副本不动它」这道闸对所有调用路径一视同仁 —— 包括界面上显式传 method
    // 的那条,而那条恰恰是真正的用户路径。#4271
    const blocked = !!activeInst && !activeInst.manageable;

    if (method) {
      return { targetPath, blocked, effectiveMethod: method, effectiveRegistry: options.registry };
    }

    // 下载源与「用哪一份」正交:钉了某一份副本的用户照样要能指定从哪个镜像取包。
    // 只认 method 选择的旧写法会让钉了副本的人默默回落官方源 —— 而没有可靠国际线路的
    // 用户点更新就直接失败。#4271
    if (hostDep === undefined) {
      // no probe yet — use recommended
      return {
        targetPath,
        blocked,
        effectiveMethod: undefined,
        effectiveRegistry: selection.registry,
      };
    }
    const provKind = activeInst?.provenance.kind;
    return {
      targetPath,
      blocked,
      effectiveMethod: isRealInstallMethod(provKind) ? (provKind as InstallMethod) : null,
      effectiveRegistry: selection.registry,
    };
  }

  /**
   * Resolves the update/uninstall command based on effective method and descriptor.
   *
   * effectiveMethod semantics:
   *   - InstallMethod: known method → use PM routing
   *   - null:          probed but no method → no plan
   *   - undefined:     no probe yet → fall back to recommended option
   */
  private resolveUpdatePlan(
    effectiveMethod: InstallMethod | null | undefined,
    descriptor: DependencyDescriptor,
    operation: 'update' | 'uninstall',
    registry?: string,
  ):
    | { kind: 'package-manager'; command: string; option: InstallOption }
    | { kind: 'none' } {
    if (effectiveMethod != null) {
      // Known method: route to the matching PM option
      const opt = pickInstallOption(descriptor, this.platform, effectiveMethod, registry)
        ?? descriptor.installCommands?.[this.platform]?.find((option) => option.replaces?.includes(effectiveMethod) && (registry === undefined || option.registry === registry));
      if (opt) {
        if (operation === 'uninstall' && opt.uninstallCommand) {
          return { kind: 'package-manager', command: opt.uninstallCommand, option: opt };
        }
        if (operation === 'update') {
          const cmd = opt.updateCommand ?? opt.command;
          if (cmd) return { kind: 'package-manager', command: cmd, option: opt };
        }
      }
    } else if (effectiveMethod === undefined) {
      // No prior probe — fall back to the recommended install option
      const fallback = pickInstallOption(descriptor, this.platform);
      if (fallback) {
        if (operation === 'uninstall' && fallback.uninstallCommand) {
          return { kind: 'package-manager', command: fallback.uninstallCommand, option: fallback };
        }
        if (operation === 'update') {
          const cmd = fallback.updateCommand ?? fallback.command;
          if (cmd) return { kind: 'package-manager', command: cmd, option: fallback };
        }
      }
    }

    return { kind: 'none' };
  }

  async probeAll(options: DependencyProbeOptions = {}): Promise<void> {
    await this.refreshShellEnvIfRequested(options);
    await this.probeMany(this._dependencies);
  }

  async probeCategory(
    cat: DependencyCategory,
    options: DependencyProbeOptions = {},
  ): Promise<void> {
    await this.refreshShellEnvIfRequested(options);
    const targets = this._dependencies.filter((d) => d.category === cat);
    await this.probeMany(targets);
  }

  /** A low-vCPU host cannot run every CLI version probe concurrently without starving its agent. */
  private async probeMany(targets: readonly DependencyDescriptor[]): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, targets.length) }, async () => {
      while (next < targets.length) {
        const dependency = targets[next++]!;
        try { await this.probe(dependency.id, { waitForInstallations: true }); }
        catch (probErr) {
          this.logger.warn(`[HostDependencyManager] Failed to probe ${dependency.id}:`, probErr);
        }
      }
    }));
  }

  /**
   * Run the install command for a dependency, then re-probe to update state.
   * When `method` is provided, picks the matching InstallOption for the manager's platform;
   * otherwise picks the recommended/first option.
   * After a successful install, invalidates the detector cache so re-probe picks up
   * the new binary's provenance correctly.
   */
  async install(
    id: DependencyId,
    method?: InstallMethod,
    options: HostDependencyRunOptions = {},
  ): Promise<DependencyInstallResult> {
    const descriptor = this._getDependencyDescriptor(id);
    if (!descriptor) {
      return err({ type: 'unknown-dependency', id });
    }

    // 本次要试的源,按顺序。用户手动指定了源就只有那一条 —— 他指名要它,❌ 不许悄悄换。
    // 没指定时用测速排出来的顺序;一条都没有(还没测过)就走 descriptor 的推荐源。
    const attempts: Array<string | undefined> =
      options.registry !== undefined
        ? [options.registry]
        : options.registries && options.registries.length > 0
          ? [...options.registries]
          : [undefined];

    let option = pickInstallOption(descriptor, this.platform, method, attempts[0]);
    let command = option?.command;

    if (!command) {
      return err({ type: 'no-install-command', id });
    }

    await this.ctx.refreshShellEnv?.();

    const runInstallCommand = options.run ?? this.runInstallCommand;
    let installResult: Result<void, InstallCommandError> | undefined;
    // 下载那一段失败就换下一个源再来一次 —— **只换一次**(spec:「自动换下一个源重试一次」)。
    // ❌ 不无限重试:一条都连不上时,用户要的是一句失败,不是三分钟的静默轮询。
    for (let attempt = 0; attempt < Math.min(2, attempts.length); attempt += 1) {
      const registry = attempts[attempt];
      const picked = pickInstallOption(descriptor, this.platform, method, registry);
      const pickedCommand = picked?.command;
      // 这个源在这个平台上没有对应的安装选项 —— 跳过它,❌ 不拿上一条命令顶着跑。
      if (!pickedCommand) continue;
      option = picked;
      command = pickedCommand;
      this.logOperation('install', attempt === 0 ? 'started' : 'retry', id, {
        command, method: option?.method ?? null, registry: registry ?? option?.registry ?? null,
      });
      // 安装命令的上下文按 option 声明的事实组装:出错时去哪儿找残骸、以及让这个安装器
      // 不提问地跑完所需的环境变量(#5719)。两者都可能缺席,缺席就不传。
      installResult = await runOperation(
        runInstallCommand, command, operationContext(option, 'install', { ...options, registry }),
      );
      if (installResult.success) break;
      if (!isDownloadStageFailure(installResult.error)) break;
    }
    if (!installResult || !installResult.success) {
      const error = installResult?.error ?? ({ type: 'no-install-command', id } as const);
      this.logOperation('install', 'failed', id, { error: error.type });
      await this.refreshAfterFailedOperation(id);
      return err(error);
    }

    await this.ctx.refreshShellEnv?.();
    this.detector.invalidate();

    this.pendingInstall.set(id, {
      method: option?.method,
      registry: option?.target?.kind === 'mise' ? option.registry ?? 'official' : pinnedRegistryIn(command, option?.registry),
      target: option?.target,
    });
    this.lastInstallRecords.delete(id);

    const state = await this.probe(id);
    if (state.status !== 'available' || (option?.target && !this.lastInstallRecords.get(id))) {
      this.logOperation('install', 'failed', id, { error: 'not-detected-after-install' });
      return err({ type: 'not-detected-after-install', id });
    }

    this.onExecutableInvalidated.emit({ id });
    this.logOperation('install', 'finished', id, { version: state.version, path: state.path });
    return ok(state);
  }

  /**
   * Apply an available update for a dependency, then re-probe.
   * Routing is driven by the active installation's provenance: method selection
   * uses the matching package-manager command; unknown/manual sources have no plan.
   * When `method` is explicitly passed it overrides the provenance-based routing.
   */
  async update(
    id: DependencyId,
    method?: InstallMethod,
    options: HostDependencyRunOptions = {},
  ): Promise<DependencyUpdateResult> {
    const descriptor = this._getDependencyDescriptor(id);
    if (!descriptor) {
      return err({ type: 'unknown-dependency', id });
    }

    const updates = descriptor.updates;
    if (!updates || updates.kind !== 'supported') {
      return err({ type: 'no-update-strategy', id });
    }

    if (updates.update.kind === 'none') {
      const state = this.state.get(id);
      if (state) return ok(state);
      return err({ type: 'no-update-strategy', id });
    }

    // 要更新的就是这一份。基线与事后校验都盯着它 —— 两头问同一个文件,才答得出「它动了没有」。
    const { targetPath, blocked, effectiveMethod, effectiveRegistry } =
      await this.resolveOperationRouting(id, method, options);

    // 生效证明的基线:命令跑之前,**面板上那一份**答的版本。
    // ❌ 旧写法读的是 PATH 上第一个答话的那份(`this.state`)。两者不是一回事:用户钉了
    // ~/.local/bin/codex(0.145.0),而咕咕自己的目录排在 PATH 更前面、已经是 0.149.1 ——
    // 拿后者当基线,「没更新到你选的那份」就被报成「版本没变 v0.149.1」,而面板同时写着
    // 0.145.0。同一屏两个答案,用户看到的就是产品自己都不知道在用哪一份。#4271
    const versionBefore = targetPath
      ? await this.probeVersionAt(descriptor, targetPath)
      : (this.state.get(id)?.version ?? null);

    if (blocked) {
      return err({ type: 'no-update-strategy', id });
    }

    this.logOperation('update', 'started', id, {
      method: effectiveMethod ?? null,
      registry: effectiveRegistry ?? null,
      targetPath,
      versionBefore,
    });

    await this.ctx.refreshShellEnv?.();

    const plan = this.resolveUpdatePlan(effectiveMethod, descriptor, 'update', effectiveRegistry);

    const runInstallCommand = options.run ?? this.runInstallCommand;

    if (plan.kind === 'package-manager') {
      // 落点不需要推导:咕咕只更新自己装的那一份(computeManageable 把门守在前面),而咕咕
      // 装的东西恒在自己的目录里 —— 宿主的默认落点就是对的。
      // ❌ 曾经从副本路径反推 npm prefix 来「更新用户自己那份」。那是对世界的推断,而且推错了:
      //    `~/.local/bin/codex` 看着像 npm 前缀,实际 npm 在 `~/.local` 下什么都不拥有。#4271
      const runResult = await runOperation(runInstallCommand, plan.command,
        operationContext(plan.option, 'update', { ...options, registry: effectiveRegistry }, targetPath ?? undefined));
      if (!runResult.success) {
        this.logOperation('update', 'failed', id, { error: runResult.error.type });
        await this.refreshAfterFailedOperation(id);
        return err(runResult.error);
      }
      this.pendingInstall.set(id, {
        method: plan.option.method,
        registry: plan.option.target?.kind === 'mise' ? effectiveRegistry ?? plan.option.registry ?? 'official' : pinnedRegistryIn(plan.command, plan.option.registry),
        target: plan.option.target,
      });
      this.lastInstallRecords.delete(id);
    } else {
      this.logOperation('update', 'failed', id, { error: 'no-update-strategy' });
      return err({ type: 'no-update-strategy', id });
    }

    await this.ctx.refreshShellEnv?.();
    this.detector.invalidate();

    const state = await this.probe(id);
    if (
      state.status !== 'available' ||
      (plan.kind === 'package-manager' && plan.option.target && !this.lastInstallRecords.get(id))
    ) {
      this.logOperation('update', 'failed', id, { error: 'not-detected-after-update' });
      return err({ type: 'not-detected-after-update', id });
    }

    this.onExecutableInvalidated.emit({ id });

    // 命令 exit 0、PATH 上也还有东西 —— 但真正要回答的是「**你选的那一份**动了没有」。
    // 所以回去问同一个路径,而不是问 PATH 上的赢家:那两个可以是不同的文件,而报错里报出
    // 哪一份,决定了用户看到的是一句能和面板对上的话,还是一句自相矛盾的话。#4271
    const verificationPath = plan.kind === 'package-manager' && plan.option.target?.kind === 'mise'
      ? this.lastInstallRecords.get(id)?.realpath ?? targetPath
      : targetPath;
    const versionAfter = verificationPath
      ? await this.probeVersionAt(descriptor, verificationPath)
      : state.version;
    if (versionBefore !== null && versionAfter === versionBefore) {
      this.logOperation('update', 'failed', id, {
        error: 'version-unchanged',
        version: versionBefore,
        path: targetPath ?? state.path,
      });
      return err({
        type: 'version-unchanged',
        id,
        version: versionAfter,
        path: targetPath ?? state.path,
      });
    }

    this.logOperation('update', 'finished', id, { versionBefore, versionAfter, path: verificationPath });
    return ok(state);
  }

  /**
   * Uninstall a dependency on this host, then re-probe to confirm it is gone.
   *
   * Routing is driven by the active installation's provenance: method selections use
   * PM uninstall commands when available (e.g. `brew uninstall <formula>`).
   * `manageable === false` → no-uninstall-strategy.
   *
   * Verify that the selected executable is gone; another installed copy may remain available.
   * Without a selected path, require a missing dependency rather than treating probe errors as absence.
   */
  async uninstall(
    id: DependencyId,
    method?: InstallMethod,
    options: HostDependencyRunOptions = {},
  ): Promise<DependencyUninstallResult> {
    const descriptor = this._getDependencyDescriptor(id);
    if (!descriptor) {
      return err({ type: 'unknown-dependency', id });
    }

    const strategy = descriptor.uninstall;
    if (!strategy || strategy.kind === 'none') {
      return err({ type: 'no-uninstall-strategy', id });
    }

    // 要卸的就是这一份;「不归咕咕管的副本不动它」这道闸卸载比更新更该守 ——
    // 更新失败还能重来,删掉不能。#4271
    const { targetPath, blocked, effectiveMethod, effectiveRegistry } =
      await this.resolveOperationRouting(id, method, options);
    if (blocked) {
      return err({ type: 'no-uninstall-strategy', id });
    }

    this.logOperation('uninstall', 'started', id, {
      method: effectiveMethod ?? null,
      targetPath,
    });

    await this.ctx.refreshShellEnv?.();

    const plan = this.resolveUpdatePlan(
      effectiveMethod,
      descriptor,
      'uninstall',
      effectiveRegistry,
    );

    const runInstallCommand = options.run ?? this.runInstallCommand;

    if (plan.kind === 'package-manager') {
      const runResult = await runOperation(runInstallCommand, plan.command,
        operationContext(plan.option, 'uninstall', options, targetPath ?? undefined));
      if (!runResult.success) {
        this.logOperation('uninstall', 'failed', id, { error: runResult.error.type });
        await this.refreshAfterFailedOperation(id);
        return err(runResult.error);
      }
    } else {
      this.logOperation('uninstall', 'failed', id, { error: 'no-uninstall-command' });
      return err({ type: 'no-uninstall-command', id });
    }

    await this.ctx.refreshShellEnv?.();
    this.detector.invalidate();

    // The binary we were describing is gone; a later reinstall must not inherit its source.
    this.pendingInstall.set(id, { method: undefined, registry: null });

    const state = await this.probe(id);
    this.onExecutableInvalidated.emit({ id });

    if (targetPath ? await resolveCommandPath(targetPath, this.ctx, this.platform, await this.resolveProbeEnv(descriptor)) : state.status !== 'missing') {
      this.logOperation('uninstall', 'failed', id, { error: 'still-present', targetPath });
      return err({ type: 'still-present', id });
    }

    this.logOperation('uninstall', 'finished', id, { targetPath });
    return ok(state);
  }

  private async refreshAfterFailedOperation(id: DependencyId): Promise<void> {
    this.detector.invalidate();
    this.onExecutableInvalidated.emit({ id });
    try { await this.probe(id); }
    catch (error) { this.logger.warn('[HostDependencyManager] Failed to refresh after operation failure', { id, error }); }
  }

  /** Returns the resolved install options for a dependency on the current platform. */
  getInstallOptions(id: DependencyId) {
    const descriptor = this._getDependencyDescriptor(id);
    if (!descriptor) return [];
    return resolveInstallOptions(descriptor, this.platform);
  }

  /**
   * 直接问某一个绝对路径上的那份二进制:你是哪个版本。
   *
   * 与 `probe()` 的区别是它**不走 PATH**。更新的基线和事后校验必须盯着同一份文件,否则
   * 「更新有没有落到你选的那一份上」这个问题根本没被问过 —— 问的是「PATH 上的赢家变了没」,
   * 而那两份可以是完全不同的文件。#4271
   */
  private async probeVersionAt(
    descriptor: DependencyDescriptor,
    absolutePath: string,
  ): Promise<string | null> {
    const probe = await runVersionProbe(
      descriptor.commands[0] ?? descriptor.id,
      absolutePath,
      descriptor.versionArgs ?? ['--version'],
      this.ctx,
      { env: await this.resolveProbeEnv(descriptor) },
    );
    return extractVersion(probe, descriptor.versionLine);
  }

  private async resolveFirstPath(descriptor: DependencyDescriptor): Promise<string | null> {
    // Discovery and version probes share the host's current environment. A worker's
    // inherited PATH predates installations completed after it was started (#465).
    const probeEnv = await this.resolveProbeEnv(descriptor);
    for (const command of descriptor.commands) {
      const path = await resolveCommandPath(command, this.ctx, this.platform, probeEnv);
      if (path) return path;
    }
    const known = await resolveKnownPaths(descriptor.knownPaths?.[this.platform] ?? [], this.ctx, this.platform, probeEnv);
    return known[0] ?? null;
  }

  private async refreshShellEnvIfRequested(options: DependencyProbeOptions = {}): Promise<void> {
    if (options.refreshShellEnv) {
      await this.ctx.refreshShellEnv?.();
    }
  }

  private updateState(state: DependencyState): void {
    this.state.set(state.id, state);
    this.onStatusUpdated.emit({
      id: state.id,
      state,
      connectionId: this.connectionId,
    });
  }
}
