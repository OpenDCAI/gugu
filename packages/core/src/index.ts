// @@@logging (#2382) - core 的注入式日志出口(宿主在启动时用 setCoreLoggerFactory 接管)。
export { coreLogger, setCoreLoggerFactory, type CoreLogger, type CoreLoggerFactory } from './log'
export {
  DEFAULT_AGENT_TYPE,
  VALID_AGENT_TYPES,
  normalizeAgentType,
  type AgentType
} from './agentTypes'
export {
  DEFAULT_HOME_NAME,
  atomicWriteText,
  ensureStateDirs,
  resolveGuguHome,
  stateDir,
} from './local/state/paths'
export {
  clearHumanAuthSession,
  humanAuthSessionFile,
  readHumanAuthSession,
  readFreshHumanAuthSession,
  writeHumanAuthSession,
  type FreshHumanAuthDeps,
  type HumanAuthRefreshOwner,
  type HumanAuthSession
} from './local/identity/humanAuthSession'
export {
  agentProviderSessionEnvVar,
  detectAgentProviderSession,
  getCurrentAgentProviderSessionId,
  type AgentProviderSessionDetection,
  type AgentProviderSessionEnvVar
} from './local/agent/agentProviderSession'
export {
  type JsonlSearchResult,
  type RuntimeInfoOptions
} from './local/agent/runtimeInfo'
export {
  describeTranscript,
  listLocalTranscriptFiles,
  readLocalTranscript
} from './local/agent/transcriptInventory'
export type { TranscriptInventoryOptions } from './local/agent/transcriptInventory'
export {
  TRANSCRIPT_SOURCE_SPECS,
  allTranscriptSourceSpecs,
  requireTranscriptSourceSpec
} from './local/agent/transcriptSources'
export type {
  JsonlTranscriptSourceSpec,
  TranscriptFrame,
  TranscriptScanOptions,
  TranscriptSourceSpec,
  TranscriptStorageChannel
} from './local/agent/transcriptSource'
export { createLocalSessionIndex } from './local/agent/sessionIndex'
export type {
  LocalSessionIndex,
  LocalSessionIndexOptions,
  LocalSessionPage,
  LocalSessionQuery
} from './local/agent/sessionIndex'
export { TRANSCRIPT_SOURCE_IDS } from './shared/types/transcripts'
export type {
  ImportedTranscript,
  ImportedTranscriptTurn,
  LocalTranscriptSession,
  TranscriptSource
} from './shared/types/transcripts'
export {
  clearLocalAgentRuntimesForOwnerChange,
  engineIdForAgentType,
  handleAgentDeliverDeviceCommand,
  handleAgentStopDeviceCommand,
  handleAgentSetModelDeviceCommand,
  type AgentDeliverDeviceCommandResult,
  type AgentDeliverDevicePayload,
  type AgentRuntimeStateReport,
  type ClearLocalAgentRuntimesOptions,
  type AgentStopDeviceCommandResult,
  type AgentSetModelDeviceCommandResult,
  type AgentSetModelDevicePayload,
  type AgentModelSelectionApplied,
  type AgentModelSelectionNativeSession,
  type AgentStopDevicePayload,
  type AgentRuntimeBridgeOptions,
  type HandleAgentDeliverDeviceCommandOptions,
  type HandleAgentStopDeviceCommandOptions,
  type HandleAgentSetModelDeviceCommandOptions,
  type AgentRuntimeBridge
} from './local/agent/deviceCommandRuntime'
export {
  agentRuntimeSessionFile,
  detectAgentRuntimeSession,
  readAgentRuntimeSession,
  resolveAgentRuntimeSessionIdentity,
  removeAgentRuntimeSession,
  writeAgentRuntimeSession,
  type AgentRuntimeAuthSession,
  type AgentRuntimeKind,
  type AgentRuntimeSessionDetection,
  type AgentRuntimeSessionIdentity
} from './local/agent/agentRuntimeSession'
// Legacy agent-reply rows are internal migration residue; only the startup quarantine is public.
export {
  attachFreeformAgent,
  type FreeformAttachResult
} from './local/agent/freeformCapture'
export {
  activateGuestAgent,
  ensureGuestForProviderSession
} from './local/agent/guestRegistration'
export {
  markAgentDeliveredMessageRead,
  type AgentDeliveredMessageRead
} from './local/agent/deliveredReadMarkers'
export {
  NodeCommandRunner,
  createNodeCommandRunner,
  type CommandRunOptions,
  type CommandRunResult,
  type CommandRunner
} from './local/terminal/commandRunner'
export {
  agentsFile,
  cachedProviderSessionId,
  createAgent,
  createGuestAgentForProviderSession,
  getAgent,
  isGuestAgentRecord,
  listAgents,
  matchAgentByProviderSessionId,
  removeAgents,
  updateAgent,
  type LocalAgentUpdate,
  type LocalAgentRecord
} from './local/state/agents'
export {
  findReapedAgentForSession,
  listReapedAgents,
  recordReapedAgents,
  reapedAgentsFile,
  type ReapedAgentTombstone,
} from './local/state/agentTombstones'
export {
  AGENT_OWNER_CACHE_KEY,
  agentMayBelongTo,
  agentOwnerUserId,
  agentsForOwner,
} from './local/state/agentOwner'
export {
  AGENT_CLOUD_IDENTITY_STATE_CACHE_KEY,
  agentCloudIdentityPending,
  agentCloudIdentityState,
} from './local/state/agentCloudIdentity'
export {
  cachedAgentModelSelection,
  findLocalAgentByUserId,
  catalogEngineIdForAgent,
  agentModelSelectionForProtocol,
  isModelAccessProtocol,
  normalizeAgentModelSelection,
  platformModelAccessEnv,
  setLocalAgentModelSelection,
  MODEL_ACCESS_PROTOCOL_IDS,
  type AgentModelSelection,
  type ModelAccessProtocol,
} from './local/agent/modelAccess'
// 计费领域层(积分 = 唯一货币、1 积分 = $1 牌价用量,额度窗口 = 一个订阅周期一个池子);
// renderer 的 view-model 不在这里。
export {
  deriveSpendWindow,
  deriveSpendingPower,
  isLowBalance,
  quotaSpendWindows,
  windowHours,
  LOW_BALANCE_CREDITS,
  type QuotaWindows,
  type SpendBlockReason,
  type SpendWindow,
  type SpendingPower,
} from './billing'
export {
  createAgentDeliverDeviceCommandInsert,
  getDeviceCommand,
  insertAgentDeliverDeviceCommand,
  normalizeDeviceCommand,
  pollDeviceCommandUntilDone,
  processPendingDeviceCommandsOnce,
  recoverOrphanedDeviceCommands,
  reportRuntimeInstanceHeartbeat,
  type AgentDeliverDeviceCommandInput,
  type DeviceCommandHandlers,
  type DeviceCommandTableClient,
  type PendingDeviceCommand,
  type PollDeviceCommandOptions,
  type ProcessDeviceCommandOptions,
  type ProcessDeviceCommandResult
} from './cloud/deviceCommands'
export {
  createAgentRuntimeStateReporter,
  DEVICE_COMMAND_DRAIN_RETRY_INTERVAL_MS,
  DEVICE_SUPERVISE_INTERVAL_MS,
  DEVICE_HEARTBEAT_INTERVAL_MS,
  DEVICE_SESSION_DIGEST_LIMIT,
  detectDeviceCapabilities,
  deviceFile,
  deterministicDeviceId,
  readCachedDeviceId,
  resolveLocalDeviceId,
  createLocalDeviceIdResolver,
  resolveMachineHardwareId,
  resolveServerMachineId,
  resolveTier,
  runDeviceRuntimeTick,
  syncDeviceHeartbeat,
  cleanupLegacyDeviceRows,
  writeDeviceIdCache,
  type DeviceCapabilities,
  type DeviceCapabilityProbe,
  type DeviceIdCacheWriter,
  type DeviceHeartbeatOptions,
  type DeviceHeartbeatTableClient,
  type DeviceMachineIdentifier,
  type DeviceOperationContext,
  type DeviceRuntimeTickInput,
  type DeviceRuntimeTickResult,
  type DeviceSessionDigestEntry,
  type DeviceSessionDigestSource,
  type AgentRuntimeStateRpcClient
} from './cloud/deviceRuntime'
export {
  DEVICE_OPERATION_TIMEOUTS,
  DeviceOperationTimeoutError,
  type DeviceOperationTimeoutOverrides,
  type DeviceOperationTimeouts,
} from './cloud/deviceOperationTimeouts'
export {
  RuntimeAuthError,
  RuntimeAuthExpiredError,
  RuntimeAuthRefreshTimeoutError,
  RuntimeAuthUnavailableError,
  RUNTIME_AUTH_REFRESH_TIMEOUT_MS,
  accessTokenExpirySeconds,
  createRefreshingRuntimeAuthProvider,
  refreshSupabaseSession,
  requireRuntimeAuth,
  runtimeAuthFromSupabaseTokens,
  userIdFromSupabaseAccessToken,
  type RefreshingRuntimeAuthProviderInput,
  type RuntimeAuth,
  type RuntimeAuthProvider
} from './cloud/runtimeAuthProvider'
export {
  provisionOwnedAgent,
  provisionSessionpageAgentOneTrip,
  type ProvisionOwnedAgentInput,
  type ProvisionedOwnedAgent,
  type ProvisionSessionpageAgentOneTripInput,
  type ProvisionedSessionpageAgentOneTrip
} from './cloud/ownedAgent'
export {
  removeAgentCloudIdentity,
  removeAgentCloudIdentityViaSupabase,
  type AgentIdentityRemovalClient,
  type RemoveAgentCloudIdentityInput,
  type RemoveAgentCloudIdentityOutcome,
  type RemoveAgentCloudIdentityViaSupabaseInput
} from './cloud/agentIdentityRemoval'
export {
  listOwnedCloudAgentsViaSupabase,
  type CloudOwnedAgent
} from './cloud/agentIdentityReconcile'
export {
  createDeviceRuntimeHostLoop,
  stopRuntimeHostWithTimeout,
  type DeviceRuntimeHost,
  type DeviceRuntimeHostDebugSnapshot,
  type DeviceRuntimeHostOptions,
  type DeviceRuntimeHostTickResult,
  type DeviceRuntimeIdentityClient,
  type RuntimeStopHost,
  type SubscribeDeviceCommandWake,
  type SubscribeDeviceRpc
} from './cloud/deviceRuntimeHost'
export { listDevices, isPhoneDevice, normalizeDeviceRow, normalizeDeviceStatus, isDeviceRemovedError, DEVICE_REMOVED_PREFIX, recentMachineLimitRefusal, type DeviceTableClient, type MachineLimitRefusalRpcClient } from './cloud/devices'
export {
  parseMachineLimitRefusal,
  machineLimitRefusalFromError,
  machineLimitMessage,
  MACHINE_LIMIT_NEXT_STEP,
  MACHINE_LIMIT_ERROR,
  DEVICE_LIMIT_REACHED_PREFIX,
  type MachineLimitRefusal,
  type MachineLimitKind,
} from './cloud/machineLimit'
export {
  resolveDeviceHostInfo,
  parseServerUpdateState,
  describeOsName,
  SERVER_UPDATE_STATE_FILE,
  SERVER_ROLLBACK_FILE,
  SUPERVISOR_HEALTH_FILE,
  parseServerRollback,
} from './cloud/deviceHostInfo'
export {
  serverMachineNotices,
  formatBytes,
  REMOTE_PROTOCOL_VERSION,
  MIN_CLIENT_PROTOCOL,
  MIN_SERVER_PROTOCOL,
  SERVER_DISK_LOW_BYTES,
  type ServerMachineNotice,
} from './cloud/serverMachineHealth'
export {
  readDeviceSshTarget,
  type SettingsTableClient
} from './cloud/deviceSshConfig'
export {
  readAgentCreateDefaults,
  rememberAgentCreateDevice,
  rememberAgentCreateProject
} from './cloud/agentCreateDefaults'
export {
  agentCreateDeviceBlockMessage,
  parseAgentCreateDefaults,
  resolveAgentCreateDevice,
  resolveAgentCreateProject,
  EMPTY_AGENT_CREATE_DEFAULTS,
  type AgentCreateDefaults,
  type AgentCreateDeviceResolution
} from './shared/ui/agentCreateDefaultsModels'
