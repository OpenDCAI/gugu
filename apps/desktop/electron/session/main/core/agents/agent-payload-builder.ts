import type { CLIAgentPluginProvider } from '@gugu/session-core/agents/plugins';
import type { Platform } from '@gugu/session-core/deps';
import {
  agentProgramsOf,
  deriveHostDependencyStatus,
  readHostDependency,
  readingFromStatus,
  resolveActiveInstallation,
  resolveInstallOptions,
  sourceKey,
  toPlatform,
} from '@gugu/session-core/deps/runtime';
import type {
  DependencyId,
  DependencyState,
  HostDependency,
  HostDependencyManager,
} from '@gugu/session-core/deps/runtime';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import type {
  AgentIconAsset,
  AgentInstallationStatus,
  AgentMetadata,
  AgentPayload,
  InstallOption,
} from '@shared/core/agents/agent-payload';
import { getDependencyDescriptor } from '../dependencies/registry';
import { providerOverrideSettings } from '../settings/provider-settings-service';
import { getPlugin, listPlugins } from './plugin-registry';
import { foldAgentPrograms } from './agent-programs';
import { forkRuntimes } from './fork-legs';

/**
 * Optional callback injected by the controller so the builder can enrich the
 * manager's HostDependency snapshot with latestVersion/updateAvailable from the
 * AgentUpdateService before building the payload.
 */
type EnrichHostDep = (id: DependencyId, hostDep: HostDependency) => HostDependency;

function buildMetadata(provider: CLIAgentPluginProvider): AgentMetadata {
  const { metadata, capabilities, assets } = provider;
  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    websiteUrl: metadata.websiteUrl,
    icon: assets.icon,
    capabilities: {
      acp: capabilities.acp,
      // 原样直通插件声明（schema 默认 {kind:'none'} 在 definePlugin 时已填好）：登录 UI
      // 只服务显式声明 supported 的家，❌ 不给没声明的家伪造通用 cli-login
      // （spec: harness-auth-surface，owner 2026-09-19「sign in to use PI models 那套删了」）。
      auth: capabilities.auth,
      hostDependency: capabilities.hostDependency,
      models: capabilities.models,
      effort: capabilities.effort,
      prompt: capabilities.prompt,
      // The plugin's `sessions.fork` is only the pty leg's claim; the payload carries both legs (fork-legs.ts).
      sessions: { ...capabilities.sessions, fork: forkRuntimes(provider) },
      autoApprove: capabilities.autoApprove,
      hooks: capabilities.hooks,
      mcp: capabilities.mcp,
      plugins: capabilities.plugins,
      sessionpage: capabilities.sessionBundle.sessionpage,
      vendorAccount: capabilities.vendorAccount,
    },
    installDocs: capabilities.hostDependency.installDocs ?? null,
  };
}

async function buildOne(
  id: AgentProviderId,
  platform: Platform,
  dependencyManager?: HostDependencyManager,
  enrichHostDep?: EnrichHostDep
): Promise<AgentPayload | null> {
  const provider = getPlugin(id);
  if (!provider) return null;

  const state = dependencyManager?.get(id);
  const settingsMeta = await providerOverrideSettings.getItemWithMeta(id);
  const descriptor = getDependencyDescriptor(id);

  const rawHostDep = dependencyManager?.getHostDependency(id);
  const hostDep =
    rawHostDep && enrichHostDep ? enrichHostDep(id as DependencyId, rawHostDep) : rawHostDep;

  // Derive top-level fields from resolveActiveInstallation so the row badge always
  // matches the detail card (both read the used per-installation value).
  const used = hostDep?.used ?? { kind: 'auto' as const };
  const usedInst = hostDep ? resolveActiveInstallation(hostDep.installations, used) : undefined;
  const latestVersion = usedInst?.latestVersion ?? null;
  const updateAvailable = usedInst?.updateAvailable ?? false;
  // 伴随程序(#6335):读数按腿合并。只有一个程序的家这里是 undefined,下面照旧。
  const programs = dependencyManager
    ? foldedCompanionFields(id, dependencyManager, enrichHostDep)
    : undefined;

  return {
    ...buildMetadata(provider),
    status: hostDep ? deriveHostDependencyStatus(hostDep) : (state?.status ?? 'missing'),
    reading: hostDep ? readHostDependency(hostDep) : readingFromStatus(state?.status ?? 'missing'),
    version: usedInst?.version ?? state?.version ?? null,
    latestVersion,
    updateAvailable,
    command: usedInst?.pathEntry ?? state?.path ?? null,
    settings: settingsMeta,
    installOptions: descriptor ? resolveInstallOptions(descriptor, platform) : [],
    installations: hostDep?.installations ?? [],
    used,
    usedId: sourceKey(used),
    ...programs,
  };
}

/**
 * 某一行依赖的状态 DTO(主程序或伴随程序)。还没探过就是 undefined。
 */
function programInstallationStatus(
  dependencyId: string,
  dependencyManager: HostDependencyManager,
  enrichHostDep?: EnrichHostDep,
): AgentInstallationStatus | undefined {
  const state = dependencyManager.get(dependencyId as DependencyId);
  if (!state) return undefined;
  const raw = dependencyManager.getHostDependency(dependencyId as DependencyId);
  const hostDep = raw && enrichHostDep ? enrichHostDep(dependencyId as DependencyId, raw) : raw;
  return toAgentInstallationStatus(dependencyId, state, hostDep);
}

/**
 * 带伴随程序的家要覆盖到顶层的那几格(合并读数 + 逐程序 + 逐腿)。一个程序的家 → undefined。
 */
function foldedCompanionFields(
  pluginId: string,
  dependencyManager: HostDependencyManager,
  enrichHostDep?: EnrichHostDep,
): Pick<AgentInstallationStatus, 'reading' | 'status' | 'updateAvailable' | 'programs' | 'legReadings'> | undefined {
  const parts = agentProgramsOf(getPlugin(pluginId));
  if (parts.length < 2) return undefined;
  const folded = foldAgentPrograms(parts, (dependencyId) =>
    programInstallationStatus(dependencyId, dependencyManager, enrichHostDep),
  );
  if (!folded?.programs) return undefined;
  const { reading, status, updateAvailable, programs, legReadings } = folded;
  return { reading, status, updateAvailable, programs, legReadings };
}

/**
 * 「这一家」在本机的安装状态 DTO —— 列表 RPC 与状态事件共用(#6335)。
 * 伴随程序那几行不单独出门:它们折进属主那一家(`foldAgentPrograms`)。
 */
export function pluginInstallationStatus(
  pluginId: string,
  dependencyManager: HostDependencyManager,
  enrichHostDep?: EnrichHostDep,
): AgentInstallationStatus | undefined {
  return foldAgentPrograms(agentProgramsOf(getPlugin(pluginId)), (dependencyId) =>
    programInstallationStatus(dependencyId, dependencyManager, enrichHostDep),
  );
}

export async function buildAgentPayload(
  id: string,
  platform: Platform = toPlatform(process.platform),
  dependencyManager?: HostDependencyManager,
  enrichHostDep?: EnrichHostDep
): Promise<AgentPayload | null> {
  return buildOne(id as AgentProviderId, platform, dependencyManager, enrichHostDep);
}

export async function buildAgentPayloads(
  platform: Platform = toPlatform(process.platform),
  dependencyManager?: HostDependencyManager,
  enrichHostDep?: EnrichHostDep
): Promise<AgentPayload[]> {
  const results = await Promise.all(
    listPlugins().map((provider) =>
      buildOne(provider.metadata.id as AgentProviderId, platform, dependencyManager, enrichHostDep)
    )
  );
  return results.filter((r): r is AgentPayload => r !== null);
}

/**
 * 资源库 →「智能体」的投影 —— 与 composer **同一份上架名单**（#6099，owner 2026-09-21
 * 「29 家不上架的插件保留代码、先不上架」）。
 *
 * ⚠️ 从前这里另算一份：`listManagementPlugins()`（写死不看兜底开关）再把**本机装了的**
 * withheld 家逐个补回来。于是同一台机器两个答案 —— mac1 真机资源库 21 行全 Installed、
 * composer 7 家，搜 gemini 零结果。❌ 别再往回补那句「装了就列出来」：想在界面上驱动一家
 * 没上架的引擎，唯一的路是 `GUGU_SHOW_UNSUPPORTED_AGENTS=1`（它现在对两条面一视同仁），
 * 而不是让这张列表自己长出一套例外。
 *
 * 留着这个名字是为了让「两条面看到同一集合」那条判据能**各按自己的名字**读一次
 * （`tests/unit/desktop/electron/agentsLibraryOfferParity6099.test.ts`）：退回一个函数，
 * 判据就只是自己等于自己，而上次漂移恰恰发生在这一层而不是名单那一层。
 */
export async function buildManagementAgentPayloads(
  platform: Platform = toPlatform(process.platform),
  dependencyManager?: HostDependencyManager,
  enrichHostDep?: EnrichHostDep,
): Promise<AgentPayload[]> {
  return buildAgentPayloads(platform, dependencyManager, enrichHostDep);
}

export function buildAgentMetadataList(): AgentMetadata[] {
  return listPlugins().map(buildMetadata);
}

/**
 * 画图标是**查表**,不是新建入口 —— 所以这张表按 `pluginRegistry.getAll()` 全量给,
 * ❌ 不经 `listPlugins()` 那两道上架闸(plugin-registry.ts 顶上那段注释说的就是这条界线)。
 *
 * 之前图标走的是 `agents.list()`:那份名单挡掉了本机装了但没上架的家(Amp / Grok / Kimi / Qoder…),
 * 于是资源库的智能体列表(用的是「管理」名单,含这些家)、侧栏会话行、会话标签、MCP 卡片上
 * 那几家一律**画不出图标**。owner 2026-09-15:「这些智能体怎么没有图标」。
 */
export function buildAgentIconMap(): Record<string, AgentIconAsset> {
  return Object.fromEntries(
    pluginRegistry.getAll().map((provider) => [provider.metadata.id, provider.assets.icon])
  );
}

/**
 * Maps manager state for a single agent to the renderer-facing AgentInstallationStatus DTO.
 * Top-level latestVersion/updateAvailable are derived from the used installation when
 * host-dependency data is available, so the row badge always matches the update card.
 */
export function toAgentInstallationStatus(
  id: string,
  state: DependencyState,
  hostDep: HostDependency | undefined,
  installOptions: InstallOption[] = []
): AgentInstallationStatus {
  const used = hostDep?.used ?? { kind: 'auto' as const };
  const usedInst = hostDep ? resolveActiveInstallation(hostDep.installations, used) : undefined;
  return {
    id,
    status: hostDep ? deriveHostDependencyStatus(hostDep) : state.status,
    // 四态读数与 status 一起出门(#6101):判据只有一份,在 `readHostDependency`。
    reading: hostDep ? readHostDependency(hostDep) : readingFromStatus(state.status),
    version: state.version,
    latestVersion: usedInst?.latestVersion ?? state.latestVersion ?? null,
    updateAvailable: usedInst?.updateAvailable ?? state.updateAvailable ?? false,
    command: usedInst?.pathEntry ?? state.path,
    installations: hostDep?.installations ?? [],
    used,
    usedId: sourceKey(used),
    installOptions,
  };
}
