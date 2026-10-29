import type { Result } from '@gugu/session-shared';
import z from 'zod';
import type {
  InstallMethod,
  InstallOption,
  InstallTarget,
  InstallProgressReport,
  Platform,
  UninstallStrategy,
  UpdateStrategy,
  UpdatesDescriptor,
} from '../capability';

export type DependencyCategory = 'core' | 'agent';

export type DependencyId = string;

export type DependencyStatus = 'available' | 'missing' | 'error';

export interface DependencyState {
  id: DependencyId;
  category: DependencyCategory;
  status: DependencyStatus;
  version: string | null;
  path: string | null;
  checkedAt: number;
  error?: string;
  latestVersion?: string | null;
  updateAvailable?: boolean;
}

export type DependencyStatusMap = Record<string, DependencyState>;

export type { InstallPhase, InstallProgressReport } from '../capability';

export type InstallCommandError =
  | {
      type: 'permission-denied';
      message: string;
      output: string;
      exitCode?: number;
      stage?: string;
      artifacts?: InstallFailureArtifact[];
    }
  | {
      type: 'command-failed';
      message: string;
      output: string;
      exitCode?: number;
      stage?: string;
      /**
       * 停下那一刻最后一次进度(哪一步、已下多少 / 共多少、多快)。说清「卡在哪一步」用(#7199):
       * 取清单 / 下载 / 解压安装 / 校验。没有过任何进度读数就缺席。
       */
      lastProgress?: InstallProgressReport;
      artifacts?: InstallFailureArtifact[];
    }
  | {
      /** 用户主动中止。不是失败,但要如实说清机器上留下了什么。 */
      type: 'cancelled';
      message: string;
      output: string;
      stage?: string;
      /**
       * 停下那一刻最后一次进度(哪一步、已下多少 / 共多少、多快)。说清「卡在哪一步」用(#7199):
       * 取清单 / 下载 / 解压安装 / 校验。没有过任何进度读数就缺席。
       */
      lastProgress?: InstallProgressReport;
      artifacts?: InstallFailureArtifact[];
    }
  | {
      /**
       * 安装长时间一点动静都没有 —— 最常见的成因是它在等一个没人看得见的提问
       * （厂商脚本的 `[y/N]`，而咕咕的安装界面没有输入位置）。
       * ❌ 不许静默挂着:那种失败不报错、不超时,和「正在下载」长得一模一样。
       */
      type: 'stalled';
      message: string;
      output: string;
      idleMs: number;
      stage?: string;
      /**
       * 停下那一刻最后一次进度(哪一步、已下多少 / 共多少、多快)。说清「卡在哪一步」用(#7199):
       * 取清单 / 下载 / 解压安装 / 校验。没有过任何进度读数就缺席。
       */
      lastProgress?: InstallProgressReport;
      artifacts?: InstallFailureArtifact[];
    }
  | { type: 'pty-open-failed'; message: string }
  | {
      /**
       * 这里没有可用的安装通道 —— 托管安装只在跑着咕咕的那台机器上成立(远端主机、
       * 无头 worker 都没有内置 mise)。
       * ❌ 不许折成 `command-failed`:那是「跑了一条命令、它失败了」,而这里一条都没跑,
       * 用户按多少次都不会变(远端 mise 曾经就是这么被报成命令失败的,#6098)。
       */
      type: 'unsupported-host';
      message: string;
    };

/**
 * 「下载那一段」的标记(#6157)。
 *
 * 安装失败有两种:**取包那一段**挂了(源不通、超时、校验不过),和**装好之后**挂了
 * (启动器写不进去、版本对不上)。前者换个源重试一次有意义,后者重试只是把同一件事再做一遍。
 * 这条差别现在靠 `stage` 说 —— 装到一半的每一层都会把失败折成 `command-failed`,
 * 光看 `type` 分不出来。
 */
export const DOWNLOAD_STAGE = 'download';

/**
 * 这次失败值不值得**换个源**再试一次。
 *
 * ❌ 不包含 `cancelled`:用户按的是取消,再装一次是无视他。
 * ❌ 也不无差别重试:装完之后的失败换源不会有任何不同。
 */
export function isDownloadStageFailure(error: InstallCommandError): boolean {
  if (error.type === 'cancelled') return false;
  return 'stage' in error && error.stage === DOWNLOAD_STAGE;
}

/**
 * 一次失败在盘上留下的东西。
 *
 * ❌ 这里曾经有一个 `cleanable`,三处构造点全写死 `false`,于是渲染层那句
 * 「cleanup not available」对每一次失败都成立 —— 一句永远为真的话不传递任何信息。
 * 真要做清理,先有清理动作,再让这个字段回来答「这一份能不能删」。
 */
export type InstallFailureArtifact = {
  path: string;
  bytes: number | null;
};

export type InstallCommandContext = {
  mise?: {
    target: Extract<InstallTarget, { kind: 'mise' }>;
    registry?: string;
    operation: 'install' | 'update' | 'uninstall';
    selectedPath?: string;
  };
  signal?: AbortSignal;
  /** 实时读数往哪儿报。不给就不量 —— 量测本身有成本，没人看就别跑。 */
  onProgress?: (report: InstallProgressReport) => void;
};

export type DependencyInstallError =
  | { type: 'unknown-dependency'; id: string }
  | { type: 'no-install-command'; id: string }
  | InstallCommandError
  | { type: 'not-detected-after-install'; id: string };

export type DependencyInstallResult = Result<DependencyState, DependencyInstallError>;

export type DependencyUpdateError =
  | { type: 'unknown-dependency'; id: string }
  | { type: 'no-update-strategy'; id: string }
  | InstallCommandError
  | { type: 'not-detected-after-update'; id: string }
  /**
   * The update command succeeded but the version in effect did not move — the copy that answers
   * on PATH is not the copy the command wrote. Mirrors `still-present` on the uninstall side:
   * an operation that reports success without changing what actually runs is a lie, so it fails
   * loud and hands back where the unchanged copy lives. #4271.
   */
  | { type: 'version-unchanged'; id: string; version: string | null; path: string | null };

export type DependencyUpdateResult = Result<DependencyState, DependencyUpdateError>;

export type DependencyUninstallError =
  | { type: 'unknown-dependency'; id: string }
  | { type: 'no-uninstall-strategy'; id: string }
  | { type: 'no-uninstall-command'; id: string }
  | { type: 'still-present'; id: string }
  | InstallCommandError;

export type DependencyUninstallResult = Result<DependencyState, DependencyUninstallError>;

/**
 * Provenance of an installed binary: how it was installed and how confident we are.
 *
 * kind: the installation method or a non-PM origin category:
 *   - InstallMethod values (homebrew, npm, curl, …): a known package-manager or installer
 *   - 'manual': installed by directly placing the binary, no PM involved
 *   - 'version-manager': managed by a shim-based tool (mise, asdf, nvm, …)
 *   - 'unknown': could not determine origin
 *
 * confidence:
 *   - 'confirmed': queried the package manager and it confirmed ownership
 *   - 'inferred': path-substring heuristic only; may be incorrect
 *
 * managerRef: for package-manager installs, the formula/package name for targeted
 * upgrade/uninstall commands (e.g. 'claude-code' for `brew upgrade claude-code`).
 *
 * registry: which npm registry this copy came from — see the field comment; unlike the rest of
 * this type it is remembered, not detected.
 */
export type Provenance = {
  kind: InstallMethod | 'manual' | 'version-manager' | 'unknown';
  confidence: 'confirmed' | 'inferred';
  managerRef?: string;
  /**
   * npm registry this binary was installed from, present only when the install command we ran
   * pinned one with `--registry=`.
   *
   * This is remembered, never detected. npm leaves no trace of the source registry on a global
   * install: no `_resolved`/`_from` in the installed package.json, no hidden lockfile at the
   * global root, and `npm ls -g --json` reports the version alone (verified on npm 10.9). So the
   * only way to know is to write down what we ran — see InstallRecord.
   *
   * Absent means "we don't know", NOT "the official registry". An unpinned `npm install -g`
   * resolves through the user's own npm config, which may itself point at a mirror, so claiming
   * the official registry there would be a guess dressed as a fact.
   */
  registry?: string;
  /**
   * 咕咕自己装的这一份。
   *
   * 判据只有两条,都不是推断:realpath 落在咕咕自己的安装根里(我们亲手放的),或者咕咕这次
   * 安装留下的 `InstallRecord` 指着它(realpath + 版本都对得上)。
   *
   * ❌ 不要用 `confidence === 'confirmed'` 代替它:那句话的意思是「我知道是谁装的」——
   * brew 的 cellar、Caskroom、用户自己的 `npm root -g` 全都算 confirmed。**知道是谁装的,
   * 不等于归咕咕管。** 咕咕只维护自己装的那一份(product spec)。
   */
  ours?: boolean;
};

/**
 * What the app remembers about an install it performed itself.
 *
 * Written after install/update, cleared on uninstall and whenever a later install pins no
 * registry.
 *
 * **认路径,不认版本**(#6101):`realpath` 是落点 —— 咕咕自己选的那个,它才回答「这一份归不归
 * 咕咕管」。`version` 是读数,每轮探测回填。❌ 曾经两者都要对上才认,于是 claude 自己把自己
 * 升级一次(路径没动、版本变了)就把咕咕装的那一份判成别人的,更新入口当场消失。
 *
 * The method is app-issued provenance, not a path heuristic. `registry` remains optional because a
 * bare command can leave the registry source unknown. Persistence belongs to the application
 * layer, same as HostDependencySelection.
 */
export type InstallRecord = {
  /** Method the app's install command actually used, when the app knows it. */
  method?: InstallMethod;
  /** Registry id the install command pinned (see NPM_REGISTRIES), when one was explicit. */
  registry?: string;
  /** Canonical realpath of the binary immediately after that install. */
  realpath: string;
  /** Version probed immediately after that install. */
  version: string | null;
};

/**
 * Persisted discriminated union for a user-chosen install override.
 * Absence (null) means auto with no registry preference. Replaces the legacy
 * { usedId, path?, cli? } shape.
 *
 * pinned: user selected a specific binary by its absolute realpath.
 *
 * `registry` rides along on **every** kind, because it answers a different question than the kind
 * does. The kind answers "which copy do we run"; the registry answers "where do we fetch bytes
 * from, and whose 'latest' do we compare against". They are independent: picking a mirror is not
 * a statement about which copy runs (the mirrors carry the same package), and pinning a copy is
 * not a statement about where the next fetch should come from. Keeping the registry inside the
 * `method` variant alone forced the two to move together — choosing a mirror silently replaced the
 * user's copy choice, and a pinned copy with no recorded registry fell back to the official
 * registry even for a user who cannot reach it. #4271
 */
export type InstallOverride =
  | { kind: 'auto'; registry: string }
  | { kind: 'pinned'; realpath: string; registry?: string }
  | { kind: 'method'; method: InstallMethod; registry?: string }
  | { kind: 'path'; path: string; registry?: string }
  | { kind: 'cli'; command: string; registry?: string };

/**
 * Runtime / UI union. Same shape as the persisted override; `{kind:'auto'}` without a registry is
 * the value a missing entry resolves to.
 */
export type SelectedSource = { kind: 'auto'; registry?: string } | InstallOverride;

/**
 * Returns a stable string key for **which copy** a selection names.
 * 'auto' | '<realpath>' (pinned) | 'method:<m>' | 'path' | 'cli'
 *
 * ❌ The registry is deliberately NOT part of this key: it does not name a copy. Two selections
 * that differ only by registry point at the same binary, and folding the registry in here is what
 * made the source menu mark a mirror row as "in use" while a different copy was the one running.
 * The registry has its own key — see `registryKey`. #4271
 */
export function sourceKey(s: SelectedSource): string {
  if (s.kind === 'pinned') return s.realpath;
  if (s.kind === 'method') return `method:${s.method}`;
  return s.kind;
}

/** Stable key for the download-source half of a selection. */
/**
 * 两次选择是不是同一件事 —— **含下载源**。
 *
 * `sourceKey` 故意不含下载源(菜单靠它把「用哪一份」分组,镜像不构成一份副本)。所以它不能
 * 兼任「变没变」的判据:拿它比,「只换了下载源」永远读作没变,于是从主进程读回来的下载源
 * 会被原地丢掉 —— 重启后用户看到自己选的镜像不见了。#4271
 */
export function sameSelection(a: SelectedSource, b: SelectedSource): boolean {
  return sourceKey(a) === sourceKey(b) && (a.registry ?? null) === (b.registry ?? null);
}

export function registryKey(registry: string | undefined): string {
  return `registry:${registry ?? 'default'}`;
}

/**
 * Replaces which-copy while keeping where-to-download, or vice versa. The two halves of a
 * selection are set from two different menu groups and must not clobber each other.
 */
export function withCopyChoice(current: SelectedSource, next: SelectedSource): SelectedSource {
  const registry = current.registry;
  return registry === undefined ? next : { ...next, registry };
}

export function withRegistryChoice(
  current: SelectedSource,
  registry: string | undefined,
): SelectedSource {
  if (registry === undefined) {
    const { registry: _dropped, ...rest } = current;
    return rest as SelectedSource;
  }
  return { ...current, registry };
}

/**
 * Resolves a nullable persisted override to a SelectedSource.
 * null → { kind: 'auto' }
 */
export function resolveSelectedSource(override: InstallOverride | null): SelectedSource {
  return override ?? { kind: 'auto' };
}

/**
 * Returns true when an installation can be updated via the app's update action.
 *
 * Uses the installation's `manageable` flag (computed from provenance + descriptor
 * strategy) plus the strategy kind: `package-manager` is updatable when manageable,
 * `none` never is.
 */
export function installationCanUpdate(
  inst: Installation,
  strategyKind: UpdateStrategy['kind'],
): boolean {
  if (!inst.manageable) return false;
  return strategyKind !== 'none';
}

/**
 * Migrates a raw/legacy persisted value to the canonical InstallOverride | null shape.
 *
 * New format (discriminated union): round-trips as-is (including 'pinned'). An empty path/command
 * is not a selection and normalizes to null — see the comment on those two branches.
 * Legacy format ({ usedId?, path?, cli? }):
 *   - usedId === 'path' and path present → { kind:'path', path }
 *   - usedId === 'cli' and cli present    → { kind:'cli', command: cli }
 *   - usedId starts with 'method:'        → { kind:'method', method }
 *   - 'auto' / 'unknown' / absent         → null
 */
export function normalizeSelection(raw: unknown): InstallOverride | null {
  if (raw === null || raw === undefined) return null;

  // Try new discriminated-union format first
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const kind = obj['kind'];
    // 每种 kind 都可能带 registry —— 它答的是"从哪儿下载",与"用哪一份"正交。
    const reg = typeof obj['registry'] === 'string' ? { registry: obj['registry'] } : {};
    if (kind === 'pinned' && typeof obj['realpath'] === 'string') {
      return { kind: 'pinned', realpath: obj['realpath'], ...reg };
    }
    if (kind === 'method' && typeof obj['method'] === 'string') {
      return { kind: 'method', method: obj['method'] as InstallMethod, ...reg };
    }
    // 空字符串**不是**一次指定 —— 它没指着任何东西。曾经界面上点一下「手动指定…」就先存一个
    // 空的下来占位(#6087),而空的 `cli` 在启动时会让解析响亮失败 ⇒ 光是点开那一格就能把这一家
    // 变成「没装」。现在打开那一格不再写任何东西,老库里存着的空值在这里一并当作「什么都没选」。
    if (kind === 'path' && typeof obj['path'] === 'string') {
      return obj['path'].trim() ? { kind: 'path', path: obj['path'], ...reg } : null;
    }
    if (kind === 'cli' && typeof obj['command'] === 'string') {
      return obj['command'].trim() ? { kind: 'cli', command: obj['command'], ...reg } : null;
    }
    // auto 只有在带着 registry 时才值得存;不带就是"什么都没选",由 null 表示。
    if (kind === 'auto' && typeof obj['registry'] === 'string') {
      return { kind: 'auto', registry: obj['registry'] };
    }

    // Legacy format: { usedId?, path?, cli? }
    const usedId = typeof obj['usedId'] === 'string' ? obj['usedId'] : undefined;
    const legacyPath = typeof obj['path'] === 'string' ? obj['path'] : undefined;
    const legacyCli = typeof obj['cli'] === 'string' ? obj['cli'] : undefined;

    if (usedId === 'path' && legacyPath) return { kind: 'path', path: legacyPath };
    if (usedId === 'cli' && legacyCli) return { kind: 'cli', command: legacyCli };
    if (usedId?.startsWith('method:')) {
      const [method, registry] = usedId.slice('method:'.length).split('@', 2);
      return {
        kind: 'method',
        method: method as InstallMethod,
        ...(registry ? { registry } : {}),
      };
    }
  }

  return null;
}

/**
 * A single resolved installation of an agent binary on a specific host.
 *
 * Identity: `realpath` (the absolute canonical path after following symlinks).
 * `id` equals `realpath` for enumerated installations; for path/cli overrides
 * it is the literal string 'path' or 'cli' (preserved for backward-compat lookups).
 *
 * Provenance captures how the binary was installed and the confidence level.
 * `manageable` indicates whether the app can update/uninstall this installation.
 */
export type Installation = {
  /**
   * Stable lookup key.
   * Enumerated installs: absolute realpath (same as `realpath`).
   * Path override: 'path'. CLI override: 'cli'.
   */
  id: string;
  /** Absolute canonical realpath of the binary (follows symlinks). */
  realpath: string;
  /** PATH-visible path entry (symlink/shim) used to discover this binary. Null for off-PATH. */
  pathEntry: string | null;
  /** True when this is the current PATH winner (first `which` result). */
  isActive: boolean;
  /** Whether the app can manage (update/uninstall) this installation via its UI. */
  manageable: boolean;
  /** How this binary was installed and how confidently we know it. */
  provenance: Provenance;
  status: DependencyStatus;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
};

/**
 * All installations of one agent on one host, plus which SelectedSource is
 * currently authoritative for conversation spawns.
 */
export type HostDependency = {
  hostId: string;
  dependencyId: DependencyId;
  installations: Installation[];
  /** The authoritative source — the persisted override or auto. */
  used: SelectedSource;
};

/**
 * Persisted user preference for which installation to use on a specific host.
 * null = auto (no override). Never store { kind: 'auto' } — use null instead.
 * Stored in the local KV store (host='local') or SSH connection metadata (remote).
 */
export type HostDependencySelection = InstallOverride | null;

/**
 * 用户上一次指定的「自定义路径」(owner 2026-09-22:来源三种之一)。
 *
 * 选中别的来源之后它仍然记着 —— 面板上那一行照样显示那条路径、那个版本,点一下就切回去。
 * ❌ 从前切走就丢,用户得重新敲一遍(#6087 那种「单程票」)。
 */
export type CustomTarget = { kind: 'path'; path: string } | { kind: 'cli'; command: string };

export const hostDependencySelectionSchema: z.ZodType<HostDependencySelection> = z.nullable(
  z.discriminatedUnion('kind', [
    // `auto` 只在带着下载源时才值得存;不带就是「什么都没选」,由 null 表示。
    z.object({ kind: z.literal('auto'), registry: z.string() }),
    z.object({ kind: z.literal('pinned'), realpath: z.string(), registry: z.string().optional() }),
    z.object({ kind: z.literal('method'), method: z.string(), registry: z.string().optional() }),
    z.object({ kind: z.literal('path'), path: z.string(), registry: z.string().optional() }),
    z.object({ kind: z.literal('cli'), command: z.string(), registry: z.string().optional() }),
  ]),
) as z.ZodType<HostDependencySelection>;

/**
 * Resolves the active Installation from a HostDependency based on the used source.
 *
 * Resolution rules:
 *   - auto:    the installation with isActive === true (PATH winner)
 *   - pinned:  the installation whose realpath matches selection.realpath
 *   - method:  a manageable installation whose provenance.kind matches — preferring the copy
 *              recorded as coming from the selected registry, when the selection names one
 *   - path:    the path-override installation (id === 'path')
 *   - cli:     the cli-override installation (id === 'cli')
 *
 * The registry is a preference, not a filter. A source selection is forward-looking — "install
 * and update from here" — and does not claim the binary already on disk came from there. Failing
 * to match would resolve to undefined, i.e. report a working agent as missing everywhere it is
 * read, the composer's "not installed" label included, purely because the user changed a source.
 *
 * Returns undefined when no matching installation is found (dep is missing or
 * the selected installation no longer exists on disk).
 */
export function resolveActiveInstallation(
  installations: Installation[],
  used: SelectedSource,
): Installation | undefined {
  if (used.kind === 'auto') return installations.find((i) => i.isActive);
  if (used.kind === 'pinned') return installations.find((i) => i.realpath === used.realpath);
  if (used.kind === 'method') {
    const ofMethod = installations.filter(
      (i) => i.provenance.kind === used.method && i.manageable,
    );
    const fromRegistry =
      used.registry === undefined
        ? undefined
        : ofMethod.find((i) => i.provenance.registry === used.registry);
    return fromRegistry ?? ofMethod[0];
  }
  if (used.kind === 'path') return installations.find((i) => i.id === 'path');
  if (used.kind === 'cli') return installations.find((i) => i.id === 'cli');
  return undefined;
}

/**
 * Derives the overall dependency status from the currently-used installation.
 * Returns 'missing' when no matching installation is found.
 */
export function deriveHostDependencyStatus(dep: HostDependency): DependencyStatus {
  const chosen = resolveActiveInstallation(dep.installations, dep.used);
  if (chosen) return chosen.status;
  // 选中的那一份解析不出来时,**运行时会落回自动解析**(`resolveAgentExecutable`:"matches no
  // installed copy — falling back to auto-resolution")。状态就得跟着落回去,否则面板挂着
  // 「未安装」而咕咕照样把它跑起来 —— 正是 spec 里那条「面板显示哪一份,咕咕就启动哪一份」
  // 的反面。
  //
  // 实遇(#4271,owner 机器):点了一下「＋ 让咕咕装一份」,`used` 被写成一个从没兑现的
  // `{kind:'method', homebrew}`,于是装着两份能跑的 Claude Code 的机器上,列表显示「未安装」。
  return resolveActiveInstallation(dep.installations, { kind: 'auto' })?.status ?? 'missing';
}

/**
 * 「这一家现在是个什么处境」—— 界面各处共用的**一套**判据(#6101)。
 *
 * `DependencyStatus` 的三个值不够用:`missing` 一个词同时背着「这台机器上一份都没有」和
 * 「你选的那一份不在了」,而 `error`(文件在、跑不起来)在列表里被并进「未安装」——
 * 于是同一台机器上,列表说「未安装」、下拉说「检测失败」、抽屉说「读不出版本」,三处说三套话,
 * 而用户的下一步动作完全不同:该去装 / 该去修 / 该重新选一份。
 *
 * - `installed`            选中那一份在,能跑。
 * - `detected-but-broken`  文件在,`--version` 跑不出来(`defaultProbeStatus` 的 `error`)。
 * - `missing`              选中那一份不在了。别的副本可能还在,运行时会回落到自动解析 ——
 *                          所以它仍然可用,但产品得说清「你点的那一份没了」。
 * - `not-detected`         这台机器上一份都没找到。
 */
export type InstallationReading =
  | 'installed'
  | 'detected-but-broken'
  | 'missing'
  | 'not-detected';

/** 只有状态可读时的读法(手机端 / 只报 `DependencyStatus` 的通道)。 */
export function readingFromStatus(status: DependencyStatus): InstallationReading {
  if (status === 'available') return 'installed';
  if (status === 'error') return 'detected-but-broken';
  return 'not-detected';
}

/**
 * 有整份副本清单时的读法 —— 比 `deriveHostDependencyStatus` 多分得出「你选的那一份不在了」。
 *
 * 两者刻意分开:`status` 要继续跟着**运行时真会跑哪一份**走(回落自动解析),否则面板写着
 * 「未安装」而咕咕照样把它跑起来;而 `reading` 要说出「你点的那一份没了」这件事本身。
 */
export function readHostDependency(dep: HostDependency): InstallationReading {
  const chosen = resolveActiveInstallation(dep.installations, dep.used);
  if (chosen) return readingFromStatus(chosen.status);

  const auto = resolveActiveInstallation(dep.installations, { kind: 'auto' });
  // 选中的是一个**具体目标**(某个 realpath / 某条路径 / 某条命令)而它不在了。
  // 「让咕咕装一份」(`kind:'method'`)不在此列 —— 那本来就是个还没兑现的意向,不是丢了的目标。
  const namesAConcreteTarget =
    dep.used.kind === 'pinned' || dep.used.kind === 'path' || dep.used.kind === 'cli';
  if (namesAConcreteTarget && auto) return 'missing';
  return auto ? readingFromStatus(auto.status) : 'not-detected';
}

export type DependencyStatusUpdatedEvent = {
  id: string;
  state: DependencyState;
  connectionId?: string;
  /** Present after the host dependency has been computed. */
  hostDependency?: HostDependency;
};

export interface ProbeResult {
  command: string;
  path: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Number of live members observed after an isolated process-group timeout cleanup. */
  processGroupResidualCount?: number;
}

export interface DependencyDescriptor {
  id: DependencyId;
  name: string;
  category: DependencyCategory;
  /**
   * 这一行是某个插件的**伴随程序**(`HostDependencyDescriptor.companions`,#6335)时,属主插件的 id。
   *
   * 凡是「拿依赖 id 去找插件」的地方都要先折到它上:探测环境、设置里的 env、agent home 都是
   * 属主那一家的。缺席 = 这一行就是插件本身(或核心依赖)。
   */
  ownerId?: DependencyId;
  /** Binary names to try in order; first success wins. */
  commands: string[];
  /** Vendor install locations tried when no `commands` entry is on PATH (`HostDependencyDescriptor.knownPaths`). */
  knownPaths?: Partial<Record<Platform, string[]>>;
  /** Args passed when probing for a version string. Defaults to ['--version']. */
  versionArgs?: string[];
  /** The line of its `--version` output that is its own (`HostDependencyDescriptor.versionLine`). */
  versionLine?: RegExp;
  /**
   * 跑这一家时**每一次**都必须带的会话级开关(#6186:关掉它自己的自更新)。版本探测也是一次「跑它」——
   * copilot 实测 `--version` 就会把新版下载进 `~/Library/Caches/copilot/pkg`。由 `HostDependencyManager`
   * 叠在每一次探测的环境上,来源是 agent descriptor 的 `selfUpdate`。
   */
  probeEnv?: Readonly<Record<string, string>>;
  /**
   * Skip executing the CLI after resolving its path.
   * Use for CLIs whose version command has project-local side effects.
   */
  skipVersionProbe?: boolean;
  docUrl?: string;
  /** Per-platform install options from plugin metadata. */
  installCommands?: Partial<Record<Platform, InstallOption[]>>;
  /** Updates capability from plugin metadata. Absent for core dependencies. */
  updates?: UpdatesDescriptor;
  /** Uninstall strategy from plugin metadata. Absent for core dependencies. */
  uninstall?: UninstallStrategy;
}

export type DependencyProbeOptions = {
  refreshShellEnv?: boolean;
};
