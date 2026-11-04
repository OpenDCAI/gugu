import type { GuguPermissionMode, ProviderPermissionModeMap } from '@gugu/session-core/acp/client';
import { declaredInjectionTiming } from '@gugu/session-core/agents/plugins';
import type {
  AgentAuthDescriptor,
  LiveSettingsCapability,
  SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import type { InstallOption } from '@gugu/session-core/deps';
import type {
  DependencyStatus,
  Installation,
  InstallationReading,
  SelectedSource,
} from '@gugu/session-core/deps/runtime/types';
import type { ProviderCustomConfig } from '@shared/core/app-settings';
import type { SessionRuntime, SessionView, SessionpageLeg } from '@shared/core/sessions/sessions';

// ---------------------------------------------------------------------------
// Install-source model — re-exported from @gugu/session-core, never re-declared here.
//
// These declarations cross the IPC boundary, so the renderer needs them too, and it cannot
// import '@gugu/session-core/deps/runtime': that index also pulls in HostDependencyManager and
// the node-only probe helpers. The narrow './deps/runtime/types' subpath carries the same
// declarations with no node dependency, so one definition now serves both processes.
//
// The hand-written copy that used to live here did drift: its AgentUninstallError was missing
// the 'still-present' case the main process can actually return, and #3361 had to grow a
// registry branch in each copy of sourceKey/resolveActiveInstallation separately — two
// implementations of one persisted key format.
// ---------------------------------------------------------------------------

export type { InstallMethod, InstallOption } from '@gugu/session-core/deps';

export {
  readHostDependency,
  readingFromStatus,
  registryKey,
  resolveActiveInstallation,
  sameSelection,
  sourceKey,
  withCopyChoice,
  withRegistryChoice,
  type DependencyStatus,
  type InstallationReading,
  type HostDependencySelection,
  type Installation,
  type InstallOverride,
  type Provenance,
  type SelectedSource,
} from '@gugu/session-core/deps/runtime/types';

// Error DTOs. The Agent* names are what the renderer's message mappers already use; the
// declarations themselves come from the main process's own error types.
export type {
  DependencyInstallError as AgentInstallError,
  DependencyUninstallError as AgentUninstallError,
  DependencyUpdateError as AgentUpdateError,
} from '@gugu/session-core/deps/runtime/types';

/** Per-registry version shown next to each source row. Desktop-only; not part of the runtime model. */
export type InstallSourceVersion = {
  version: string | null;
  outdated: boolean;
  /**
   * True only when the registry answered and does not carry the platform build this host needs.
   *
   * npm skips an unresolvable optional dependency without failing, so such a source installs
   * "successfully" and leaves the user with a launcher whose binary is missing. Absent means we
   * could not find out — never treat that as unavailable.
   */
  platformBuildMissing?: boolean;
};

export type InstallSourceVersions = Record<string, InstallSourceVersion>;

// ---------------------------------------------------------------------------
// Narrowed capability types — only the subset the renderer reads
// ---------------------------------------------------------------------------

export type AgentUpdateStrategy = { kind: 'package-manager' } | { kind: 'none' };

export type AgentUninstallStrategy = { kind: 'package-manager' } | { kind: 'none' };

export type AgentHostDependencyInfo = {
  updates: { kind: 'supported'; update: AgentUpdateStrategy } | { kind: 'none' };
  uninstall?: AgentUninstallStrategy;
};

export type AgentModelOption = {
  name: string;
  description?: string;
  modelFeatures?: {
    contextWindowSize?: number;
    speed?: number;
    intelligence?: number;
  };
  /** Effort ids this model accepts, in display order. Absent = it takes no effort setting. */
  effortIds?: string[];
  defaultEffortId?: string;
};

export type AgentEffortOption = {
  name: string;
  description?: string;
};

export type AgentEffortCapability =
  | { kind: 'none' }
  | {
      kind: 'selectable';
      effortOptions: Record<string, AgentEffortOption>;
      resetId?: string;
      /** See the session-core effort capability: legs where platform-model levels never reach the gateway (#6218). */
      platformUndeliveredOn?: ReadonlyArray<'tui' | 'acp'>;
    };

export type AgentModelsCapability =
  | { kind: 'none' }
  | {
      kind: 'selectable';
      defaultModelId?: string;
      modelOptions: Record<string, AgentModelOption>;
      userAllowlist?: { scope: 'agent-home'; file: string; pointer: string; envVar?: string };
    };

export type AgentCapabilities = {
  acp: {
    kind: string;
    liveSettings?: LiveSettingsCapability;
    /** Stable ACP modes are a permission source unless the provider says they are a mirror. */
    sessionModes?: 'permission' | 'none';
    startup?: { noticeKey: string };
  };
  auth: AgentAuthDescriptor;
  hostDependency: AgentHostDependencyInfo;
  models: AgentModelsCapability;
  effort: AgentEffortCapability;
  prompt: { kind: string; startupDelivery?: 'startup-prompt' | 'delivery-bridge' };
  sessions: { kind: string; fork?: readonly SessionRuntime[]; freshPtyPrompt?: 'required' };
  autoApprove: {
    kind: string;
    /** harness 自报的原生档位 ↔ 咕咕三档;缺席 = 这个 harness 没声明过对应关系。 */
    modes?: ProviderPermissionModeMap;
    /** 档位表完整:缺席的档已实测为「这家没有」(#6221)。 */
    modesExhaustive?: true;
  };
  hooks: { kind: string; scope?: string };
  mcp: { kind: string };
  plugins: { kind: string };
  sessionpage?: SessionBundleDescriptor['sessionpage'];
  /**
   * 厂商账号是不是硬门槛。判据:**给足三方 key 之后跑不跑得起来** —— 跑得起来的记
   * `not-required`,哪怕它自己也提供登录方式、哪怕它文档写着要订阅。
   *
   * ⚠️ 与上面的 `auth` 不是一回事:`auth` 建的是「怎么登 / 登没登」,它的 `api-key` 方法
   *    **判不出**这件事(copilot 的 api-key 是 GitHub PAT = 仍是厂商账号,kimi 的是任意三方 key,
   *    两者在 `auth` 里同形而在这一维上相反)。
   * ⚠️ `unverified` ≠ `not-required`:前者是没测过。界面据此**不弹**提示,但那是「不知道」,
   *    不是「不需要」。
   */
  vendorAccount?:
    | { kind: 'required'; evidence: string }
    | { kind: 'not-required'; evidence: string }
    | { kind: 'unverified' };
};

export function agentSupportsAcp(capabilities: AgentCapabilities | undefined | null): boolean {
  return capabilities?.acp.kind === 'supported';
}

/**
 * 这一家给不给**这一种展示**(spec session-page 会话页:编程 / 通用)。
 *
 * 判据是「会话页给不给这条腿」,不是 `surfaces` 里写了什么 —— 前者才是运行时真会走的那条:
 *  · 编程(pty):`sessionpage['tui']` 在不在。`resolveSessionTuiHostAdapter` 抛不抛看的就是它,
 *    opencode / kimi 这些只声明了 surface 却没接通会话页那条腿的家,写了也起不来。
 *  · 通用(acp):这一家声明了 ACP **而且** acp 那一面真接通了(能被寻址、有投递通道)。
 *    owner 2026-08-21:**声明没闭合 ≠ 不支持** —— 但对用户来说,一个接不通的通用面等于没有,
 *    ❌ 不摆一个点下去才发现不行的入口。
 *
 * 建会话时(`initial-session-section`)与会话中途换展示(会话页 ⋯ 菜单)问的是同一件事,
 * 所以只有这一份判据。❌ 别在调用点再写一遍那两个字段的组合 —— 写两遍就会漂成两种脾气。
 */
export function agentOffersSessionView(
  capabilities: AgentCapabilities | undefined | null,
  view: SessionView,
): boolean {
  if (view === 'code') return capabilities?.sessionpage?.['tui'] !== undefined;
  if (!agentSupportsAcp(capabilities)) return false;
  const generalFace = capabilities?.sessionpage?.['acp'];
  return generalFace?.identity === 'addressable' && generalFace.messageTransport !== 'none';
}

/**
 * 通用面(acp)上正在跑的那一轮,这一家能不能插进一句话(#6574)。与投递、扩展插话读的是同一个
 * 读取口(`declaredInjectionTiming`);这家具体怎么插是运行时的事。
 */
export function agentSteersActiveAcpTurn(
  capabilities: AgentCapabilities | undefined | null,
): boolean {
  return declaredInjectionTiming(capabilities?.sessionpage?.['acp']) === 'next-tool-call';
}

/**
 * 这一家能不能在**这条腿**上分叉。Side chat 永远在 acp 腿上分叉;Fork 任务与来源同 runtime。
 * 入口显不显示、主进程拒不拒都问这一处 —— 终端腿的 `--fork` 证明不了聊天腿(pi:CLI 能分、pi-acp 不报 fork)。
 */
export function agentForksOn(
  capabilities: Pick<AgentCapabilities, 'sessions'> | undefined | null,
  runtime: SessionRuntime,
): boolean {
  return capabilities?.sessions.fork?.includes(runtime) === true;
}

export function agentSupportsAutoApprove(
  capabilities: AgentCapabilities | undefined | null,
): boolean {
  return capabilities?.autoApprove.kind === 'supported';
}

/**
 * 这个 agent 有没有真的支持某一档。没有就**不给**这个选项 —— 摆一个不生效的档位,
 * 用户以为锁住了 agent 其实没有,比少一个档危险得多。
 *
 * ⚠️ 判据是「它自己声明了」,不是「咕咕有这个档」。四档是产品概念,各 harness 覆盖不同:
 * codex 的 permissionProfile 里没有规划档,claude 有 `plan`。
 */
export function agentSupportsPermissionMode(
  capabilities: Pick<AgentCapabilities, 'autoApprove'> | undefined | null,
  mode: GuguPermissionMode,
  /** 会话跑在哪条腿;给了就只认这条腿兑现得了的档(见 `autoApprove.modes[*].legs`)。 */
  leg?: 'acp' | 'tui',
): boolean {
  const entry = capabilities?.autoApprove.modes?.[mode];
  return !!entry && (!leg || !entry.legs || entry.legs.includes(leg));
}

/**
 * Edit 档摆不摆(#6221):只有档位表**完整**的家才按表决定 —— qwen、cursor 的表里没有 edit,
 * 摆出来就是一句引擎兑现不了的承诺(qwen 落进 auto、cursor 落进全权 agent 模式,都比 Edit 更松)。
 * 其余家保持现状(恒摆,#6231 逐家实测后再收)。
 */
export function agentOffersEditMode(
  capabilities: AgentCapabilities | undefined | null,
  leg?: 'acp' | 'tui',
): boolean {
  return !capabilities?.autoApprove.modesExhaustive || agentSupportsPermissionMode(capabilities, 'edit', leg);
}

export function agentSupportsReadOnlyMode(
  capabilities: AgentCapabilities | undefined | null,
  leg?: 'acp' | 'tui',
): boolean {
  return agentSupportsPermissionMode(capabilities, 'read-only', leg);
}

export function agentSupportsPlanMode(
  capabilities: AgentCapabilities | undefined | null,
  leg?: 'acp' | 'tui',
): boolean {
  return agentSupportsPermissionMode(capabilities, 'plan', leg);
}

/**
 * Can this provider start an empty fresh PTY session? Codex says no: its PTY is diverted onto an
 * app-server thread whose rollout only exists once a real turn has run. This capability only gates
 * empty creation; ordinary user text always uses the message transport.
 *
 * ACP is not covered; an ACP conversation created empty is a legitimately idle chat and bootstrap
 * payloads remain system-owned (spec session-initial-status).
 */
export function agentRequiresFreshPtyPrompt(
  capabilities: AgentCapabilities | undefined | null,
): boolean {
  return capabilities?.sessions.freshPtyPrompt === 'required';
}

// ---------------------------------------------------------------------------
// Icon asset DTO — mirrors AgentIconAsset from @gugu/session-core/agents/plugins
// ---------------------------------------------------------------------------

export type AgentIconVariant = {
  minSize: number;
  light: string;
  dark?: string;
};

export type AgentIconAsset = {
  kind: 'svg' | 'image';
  alt?: string;
  variants: AgentIconVariant[];
  invertInDark?: boolean;
  /** The vendor's app-icon plate (#6157); see `iconAsset` in @gugu/session-shared/plugins. */
  plate?: { color: string; mark: 'white' | 'original' };
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type AgentSettings = {
  value: ProviderCustomConfig;
  defaults: ProviderCustomConfig;
  overrides: Partial<ProviderCustomConfig>;
};

// ---------------------------------------------------------------------------
// Top-level DTOs sent over IPC
// ---------------------------------------------------------------------------

/** Static agent metadata; host-independent and returned by `agents.list()`/`agents.get()`. */
export type AgentMetadata = {
  id: string;
  name: string;
  description: string;
  websiteUrl: string;
  icon: AgentIconAsset;
  capabilities: AgentCapabilities;
  /** Link to installation documentation, null if not set by the plugin. */
  installDocs: string | null;
};

/**
 * 一家由几个程序组成时,每个程序各自的读数(#6335:Antigravity 聊天面板腿 `agy_acp_server`、
 * 终端腿 `agy`)。只有带伴随程序的家才有这一格 —— 其余家就是顶层那一份,❌ 不为它们造一行。
 */
export type AgentProgramStatus = {
  /** 依赖管理器里那一行的 id(主程序 = 插件 id)。 */
  dependencyId: string;
  /** 给人看的名字(伴随程序声明的 `name`;主程序 = 这一家的名字)。 */
  name: string;
  /** PATH 上认的二进制名(`agy`)。 */
  binaryName: string;
  /** 这个程序服务哪几条腿。 */
  legs: SessionpageLeg[];
  reading: InstallationReading;
  status: DependencyStatus;
  version: string | null;
  /** 咕咕这台机器上有没有**自己装的**那一份(安装按钮按它判「还差哪个」)。 */
  managed: boolean;
  /** 咕咕那一份的版本(「咕咕管理」那一行报的就是它);没有那一份就是 null。 */
  managedVersion: string | null;
  /** 咕咕那一份有新版本 —— 更新动作只动这些程序。 */
  managedUpdateAvailable: boolean;
};

/** Installation status on this machine; returned by `agents.listAgentInstallationStatus()`. */
export type AgentInstallationStatus = {
  id: string;
  status: DependencyStatus;
  /**
   * 「这一家现在是个什么处境」的**四态**读数(#6101)。
   *
   * 与 `status` 并存而不是取代它:`status` 跟着**运行时真会跑哪一份**走(选中的那份没了就回落
   * 自动解析),`reading` 说的是用户该做什么 —— 去装 / 去修 / 重新选一份。界面一律读这一格,
   * ❌ 不再各处用 `status !== 'available'` 自己折一套(那正是列表把「跑不起来」并进「未安装」的来路)。
   */
  reading: InstallationReading;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  command: string | null;
  installations: Installation[];
  /** The authoritative source (persisted override or auto). */
  used: SelectedSource;
  /** @deprecated Use `used` instead. Kept for backward compat during migration. */
  usedId: string;
  /** Platform-resolved install options for this agent on the host. */
  installOptions: InstallOption[];
  /**
   * 带伴随程序的家(#6335)才有:主程序在前,逐个程序的读数。此时顶层的 `reading` / `status` /
   * `updateAvailable` 是**合并**过的(任一条腿的程序没装 ⇒ 不算装好),`installations` / `used` /
   * `version` 仍只说主程序(来源列表是主程序那一份的)。
   */
  programs?: AgentProgramStatus[];
  /** 每条腿的读数 —— 起某条腿之前按它问(`agentReadingForLeg`),缺席就是顶层 `reading`。 */
  legReadings?: Partial<Record<SessionpageLeg, InstallationReading>>;
};

/**
 * 这一家的**某条腿**现在是什么处境。选择器建的是某一条腿的会话,问的就该是那条腿的程序:
 * Antigravity 只装了聊天面板那个程序时,通用视角照样能选,编程视角要先装 `agy`(#6335)。
 */
export function agentReadingForLeg(
  agent: Pick<AgentInstallationStatus, 'reading' | 'legReadings'>,
  leg: SessionpageLeg,
): InstallationReading {
  return agent.legReadings?.[leg] ?? agent.reading;
}

/** Combined payload — used for gradual renderer migration. */
export type AgentPayload = AgentMetadata &
  Omit<AgentInstallationStatus, 'id'> & {
    settings: AgentSettings;
  };
