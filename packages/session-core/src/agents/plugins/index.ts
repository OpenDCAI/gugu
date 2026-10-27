import {
  createPluginFramework,
  iconAsset,
  type AssetDescriptors,
  type CapabilityBehaviors,
  type CapabilityDescriptors,
  type ResolvedCapabilityDescriptors,
} from '@gugu/session-shared/plugins';
import z from 'zod';
export { PLATFORM_STANDALONE_SEARCH_ROUTE, platformStandaloneSearchGranted } from './platform-search';
import { hostDependencyCapability } from '../../host-dependencies/capability';
import { acpCapability } from './capabilities/acp';
import { authCapability } from './capabilities/auth';
import { autoApproveCapability } from './capabilities/auto-approve';
import { effortCapability } from './capabilities/effort';
import { hooksCapability } from './capabilities/hooks';
import { mcpCapability } from './capabilities/mcp';
import { memoryCapability } from './capabilities/memory';
import { modelsCapability } from './capabilities/models';
import { pluginsCapability } from './capabilities/plugins';
import { promptCapability } from './capabilities/prompt';
import { sessionBundleCapability } from './capabilities/session-bundle';
import { sessionsCapability } from './capabilities/sessions';
import { subscriptionCapability } from './capabilities/subscription';
import { trustCapability } from './capabilities/trust';
import { vendorAccountCapability } from './capabilities/vendor-account';

export const PLUGIN_CAPABILITIES = {
  acp: acpCapability,
  auth: authCapability,
  autoApprove: autoApproveCapability,
  effort: effortCapability,
  hooks: hooksCapability,
  hostDependency: hostDependencyCapability,
  mcp: mcpCapability,
  memory: memoryCapability,
  models: modelsCapability,
  plugins: pluginsCapability,
  prompt: promptCapability,
  sessionBundle: sessionBundleCapability,
  sessions: sessionsCapability,
  subscription: subscriptionCapability,
  trust: trustCapability,
  vendorAccount: vendorAccountCapability,
} as const;

export type Capabilities = typeof PLUGIN_CAPABILITIES;

export const PLUGIN_ASSETS = {
  icon: iconAsset,
} as const;

export type Assets = typeof PLUGIN_ASSETS;

const metadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  websiteUrl: z.string(),
  compatibleVersions: z.string().optional(),
});

export type CLIAgentPluginMetadata = z.infer<typeof metadataSchema>;

export type CLIAgentPluginDefinition = {
  metadata: CLIAgentPluginMetadata;
  capabilities: ResolvedCapabilityDescriptors<Capabilities>;
  assets: AssetDescriptors<Assets>;
  validate(): z.ZodError[];
};

export type CLIAgentPluginProvider = CLIAgentPluginDefinition & {
  behavior: CapabilityBehaviors<Capabilities>;
};

const pluginFramework = createPluginFramework(PLUGIN_CAPABILITIES, metadataSchema, PLUGIN_ASSETS);

export const definePlugin: (
  metadata: CLIAgentPluginMetadata,
  capabilities: CapabilityDescriptors<Capabilities>,
  assets: AssetDescriptors<Assets>
) => CLIAgentPluginDefinition = pluginFramework.definePlugin;

export const registerPluginBehavior: (
  plugin: CLIAgentPluginDefinition,
  behavior: CapabilityBehaviors<Capabilities>
) => CLIAgentPluginProvider = pluginFramework.registerPluginBehavior;

export type {
  PluginIconAsset as AgentIconAsset,
  PluginIconVariant as AgentIconVariant,
} from '@gugu/session-shared/plugins';

// Convenience re-exports for impl packages
export {
  providerConsumesStartupPrompt,
  providerStartupTurnViaLocalSession,
  type AgentCommand,
  type CommandContext,
} from './capabilities/prompt';
export type {
  CanonicalHookEvent,
  HookEvent,
  HookRegistration,
  HookWaitKind,
  NotificationType,
} from './capabilities/hooks-types';
export { HOOK_WAIT_KINDS } from './capabilities/hooks-types';
export type { PluginFs } from '../runtime/fs';
export type { EffortOptionDescriptor } from './capabilities/effort';
export { platformArmedEffort } from './capabilities/effort';
export {
  resolveModelEfforts,
  type EffortCapabilityShape,
  type ModelsCapabilityShape,
  type ResolvedModelEfforts,
} from './model-efforts';
// Capability behavior interfaces — needed for dts portability
export type {
  IAcpBehavior,
  AcpBridgeSource,
  AcpCommandDiscoveryContext,
  AcpStorageForkContext,
  AcpTurnEndContext,
  AcpSessionPrepareContext,
  AcpSpawnContext,
  AcpSpawnResult,
  AcpProcessIo,
  AcpAgentApi,
  AcpClientFactory,
  LiveSettingCapability,
  LiveSettingChannel,
  LiveSettingDimension,
  LiveSettingsCapability,
} from './capabilities/acp';
export { UNSUPPORTED_LIVE_SETTINGS, liveSettingsCapabilitySchema } from './capabilities/acp';
export type {
  AgentAuthContext,
  AgentAuthDescriptor,
  AgentAuthMethod,
  AgentAuthStatus,
  AgentProgramAuthDescriptor,
  HarnessModelCredentialStatus,
  IAgentAuthBehavior,
  IAgentProgramAuthBehavior,
} from './capabilities/auth';
export type { HarnessPresence, HarnessPresenceFile, HarnessPresenceStatus, HooksDescriptor, IHooksBehavior } from './capabilities/hooks';
export type {
  ISubscriptionBehavior,
  SubscriptionPayer,
  SubscriptionPlanReading,
  SubscriptionUsageReading,
  SubscriptionUsageUnavailableReason,
  SubscriptionUsageWindow,
} from './capabilities/subscription';
export {
  subscriptionPlanReadingSchema,
  subscriptionUsageReadingSchema,
} from './capabilities/subscription';
export type {
  IMcpBehavior,
  McpScopeDir,
  McpScopedServers,
  McpServerRegistration,
  McpSurfaceToolNames,
  McpToolNames,
} from './capabilities/mcp';
export { mcpToolNamesOn } from './capabilities/mcp';
export type {
  AgentMemoryChannel,
  AgentMemoryDescriptor,
  AgentMemoryDocument,
  AgentMemoryEntry,
  AgentMemoryScope,
} from './capabilities/memory';
export {
  memoryChannelsForScope,
  memoryEntriesForScope,
  memorySourceToProviderId,
  PERSISTED_MEMORY_SOURCE_IDS,
  readAgentMemoryDocuments,
} from './capabilities/memory';
export type {
  CredentialCarrier,
  CredentialSink,
  HarnessPlatform,
  HarnessWireProtocol,
  InjectionProcess,
  InjectionSurface,
  ModelSlot,
  PlatformSurfaceInjection,
  TokenLifetime,
  TokenReuseProbe,
} from './capabilities/platform';
export { PLATFORM_NOT_WIRED } from './capabilities/platform';
export type { IPlatformModelBehavior, PlatformModelInput, PlatformModelLoad } from './capabilities/platform-model';
export { PLATFORM_PROVIDER_NAME, positiveWindow, trimmedValue } from './capabilities/platform-model';
export type { IPlugins } from './capabilities/plugins';
export type {
  AgentConfigRoot,
  NativeHome,
  ShellEnv,
  AgentFirstRunState,
  AgentFirstRunStateContext,
  AgentFirstRunStateFormat,
  CapabilityPackage,
  ExtensionSkill,
  CapabilityUnit,
  Degradation,
  DirectorySymlinkOverlay,
  ExtensionDelivery,
  GeneratedArtifact,
  GeneratedSymlink,
  HarnessSessionSurface,
  HarnessSelfUpdateControl,
  HarnessSessionChannelKind,
  ISessionBundleBehavior,
  JsonMerge,
  ModelConfigDialect,
  PlatformCallableRoutes,
  RetiredArtifact,
  SessionAutonomyCapability,
  SessionBundleDescriptor,
  SessionCredentialLifecycle,
  SessionCredentialLifecycleBySurface,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationField,
  SessionCoexistence,
  SessionCoexistenceDimension,
  SessionMaterializationContext,
  SessionRuntimeCompatibility,
  SessionBundleNativeChannel,
  SessionMcpServer,
  SessionModelCapability,
  SessionPromptBlocks,
  SessionpageInjectionDeclaration,
  SessionpageInjectionTiming,
  SessionpageSessionIntegration,
  SessionpageSessionSurface,
  SessionTuiDeliveryToolNames,
  SessionTuiHostAdapter,
  SessionpageHostAdapter,
  SessionTuiInterrupt,
  SessionTuiQuestionAnswer,
  TomlOverlay,
  JsonOverlay,
  UnitDelivery,
  SurfaceScopedUnitDelivery,
} from './capabilities/session-bundle';
export {
  MODEL_CONFIG_DIALECT,
  EVIDENCE_CITATION_PATTERN,
  citedEvidenceSchema,
  harnessSelfUpdateLaunch,
  hasCitedEvidence,
  matchesRuntimeCompatibility,
  requiredExactRuntimeCompatibility,
} from './capabilities/session-bundle';
export {
  SESSION_BUNDLE_CHANNEL_MATERIALIZATION_FIELDS,
  extensionSkillFolderName,
  mountsExtensionSkillsNatively,
} from './capabilities/session-bundle';
// 独立 home 的**类型层**。⚠️ 算路径与落盘都在 `helpers/agent-home.ts`(node 侧)——
// 这个桶进渲染包,加一行 node import 会让浏览器里一批组件测试集体炸(见那边注释)。
export {
  AGENT_HOMES_DIRNAME,
  agentHomeSegments,
  type ResolvedAgentHome,
} from './capabilities/config-root';
// 按腿声明的读取口 —— `units.*` 现在可能是 `{kind:'per-surface'}`,❌ 别在别处手写
// `.kind === 'native'`,那会把「两条腿都通」静默读成「没通」。
export {
  declaredInjectionTiming,
  declaresSessionTuiLeg,
  resolveUnitDelivery,
  sessionMcpDeliveryOn,
  promptBlocksReplayedEverySpawn,
  unitDeliveryIsNativeAnywhere,
  unitDeliveryIsNativeEverywhere,
  resolveSessionCredentialLifecycle,
} from './capabilities/session-bundle';
// 引擎支持档(owner 2026-08-24「不支持的 agent 也不给用户用的空间了」)。
// ⚠️ 单向:index -> support-tier。support-tier ❌ 不许反向 import 本文件,会成环。
export {
  agentSupportTier,
  probeAgentSupport,
  probeGuguIntegration,
  shouldOfferUnsupportedAgents,
  SHOW_UNSUPPORTED_AGENTS_ENV,
  type AgentSupportProbe,
  type AgentSupportTier,
} from './capabilities/support-tier';
export {
  BASE_SESSION_COEXISTENCE,
  SESSION_BUNDLE_UNIT_DIMENSIONS,
  SESSION_COEXISTENCE_DIMENSIONS,
  resolveSessionCoexistence,
} from './capabilities/session-bundle';
export type {
  TuiHookReturn,
  TuiHooksShape,
  TuiInterruptWrite,
} from './capabilities/tui-coexistence';
export {
  TUI_HOOK_OBSERVABILITY,
  TUI_INTERRUPT_PAUSE,
  TUI_TURN_BOUNDARY_HOOK_EVENT,
  resolveTuiHookReturn,
  tuiInterruptSurfaceRequirement,
  tuiInterruptWrites,
  tuiObservabilityFromHooks,
  tuiPauseFromInterrupt,
} from './capabilities/tui-coexistence';
export type { ISessionsBehavior, SessionStorageForkContext } from './capabilities/sessions';
export type {
  ConfigFileTrustBehavior,
  FirstRunStateTrustBehavior,
  ITrustBehavior,
  RuntimeArgvTrustBehavior,
  RuntimeEnvTrustBehavior,
  TrustChannel,
  TrustContext,
} from './capabilities/trust';
export { AgentPluginHost } from './plugin-host';
export {
  assertSessionRuntimeCompatible,
  applySessionRuntimeCommand,
  resolveSessionRuntimeCompatible,
  assertSessionSurfaceDeclared,
  clearRuntimeVersionProbeCache,
  HarnessStartupError,
  SessionRuntimeCompatibilityError,
  type SessionRuntimeResolution,
  type SessionRuntimeCompatibilityErrorCode,
} from './session-runtime-compatibility';
export type {
  AgentHomeProvisioner,
  AgentHostAcpSpawn,
  AgentHostDeps,
  AgentHostError,
  AgentHostLoginCommand,
  ResolvedAcpProvider,
  ResolvedAuthProvider,
  ResolvedTuiProvider,
} from './plugin-host';

// Typed registry factory
export { createPluginRegistry, type PluginRegistry } from '@gugu/session-shared/plugins';
