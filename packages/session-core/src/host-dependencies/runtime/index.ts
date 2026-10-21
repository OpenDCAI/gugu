export { CORE_DEPENDENCIES } from '../core-dependencies';
export type { Platform } from '../capability';
export { inferMethod } from './location-hints';
export { createInstallMethodDetector, type InstallMethodDetector } from './method-detection';
export {
  createLedgerBackedDetector,
  createReplicaLedger,
  EMPTY_MANAGED_INSTALL_DIRS,
  type HostDependencyLedger,
  type HostDependencyLedgerEntry,
  type HostDependencyLedgerSnapshot,
  type ManagedInstallDirs,
  type ReplicaHostDependencyLedger,
} from './ledger';
export { resolveInstallOptions, pickInstallOption, toPlatform } from './install-options';
export {
  deriveHostDependencyStatus,
  hostDependencySelectionSchema,
  installationCanUpdate,
  normalizeSelection,
  DOWNLOAD_STAGE,
  isDownloadStageFailure,
  readHostDependency,
  readingFromStatus,
  resolveActiveInstallation,
  resolveSelectedSource,
  sameSelection,
  sourceKey,
  type DependencyCategory,
  type DependencyDescriptor,
  type DependencyId,
  type DependencyInstallError,
  type DependencyInstallResult,
  type DependencyProbeOptions,
  type DependencyState,
  type DependencyStatus,
  type DependencyStatusMap,
  type DependencyStatusUpdatedEvent,
  type DependencyUninstallError,
  type DependencyUninstallResult,
  type DependencyUpdateError,
  type DependencyUpdateResult,
  type HostDependency,
  type CustomTarget,
  type HostDependencySelection,
  type InstallCommandError,
  type InstallCommandContext,
  type InstallFailureArtifact,
  type InstallationReading,
  type InstallOverride,
  type InstallRecord,
  type Installation,
  type Provenance,
  type SelectedSource,
  type ProbeResult,
} from './types';
export {
  HostDependencyManager,
  type HostDependencyRunOptions,
  type HostDependencyManagerOptions,
  type InstallCommandRunner,
} from './host-dependency-manager';
export {
  resolveAllCommandPaths,
  resolveCommandPath,
  resolveRealpath,
  runVersionProbe,
  withProbeSwitches,
} from './probe';
export {
  makeHarnessRuntimeIdentity,
  type HarnessRuntimeIdentity,
} from './harness-runtime-diagnostics';
export {
  agentProgramFor,
  agentProgramsOf,
  authProgramRole,
  buildDescriptorFromProvider,
  buildDescriptorsFromProvider,
  type AgentProgram,
  type AgentProgramPart,
  type AgentProgramRole,
} from '../descriptor-from-provider';
