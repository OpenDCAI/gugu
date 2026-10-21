export interface CoverageManifestGroup {
  id: string
  workflow?: string
  job?: string
  requiredGate?: string
}

export interface CoverageManifest {
  version: number
  automaticExecutors: CoverageManifestGroup[]
  exemptionReasons: Record<string, string>
  exemptions: Record<string, string>
}

export interface CoverageAuditResult {
  discovered: string[]
  errors: string[]
  groupCounts: Array<{
    id: string
    disposition: string
    count: number
    reason?: string
  }>
}

export interface WorkflowEntry {
  path: string
  workflow: Record<string, unknown>
}

export interface RunnerCommand {
  runner: 'vitest' | 'playwright'
  args: string[]
  workflow: string
  job: string
  env: Record<string, string>
}

export interface ChangedSpecExecutionResult {
  candidates: string[]
  commands: RunnerCommand[]
  executed: string[]
  gaps: string[]
}

export function declaresTestCase(sourceText: string, filePath: string): boolean
export function listTrackedSources(root: string): string[]
export function discoverSpecFiles(options: { root: string; trackedPaths?: string[] }): string[]
export function auditCoverage(options: {
  root: string
  manifest?: CoverageManifest
  trackedPaths?: string[]
  collectExecutorFiles?: (root: string, commands: RunnerCommand[]) => string[]
}): CoverageAuditResult
export function isChangedExecutionCandidate(file: string): boolean
export function listChangedPaths(root: string, base: string, head: string): string[]
export function workflowRunsForPullRequest(
  workflow: Record<string, unknown>,
  changedPaths: string[],
  baseRef?: string,
  eventAction?: string,
): boolean
export function collectAutomaticRunnerCommands(options: {
  workflows: WorkflowEntry[]
  changedPaths: string[]
  packageScripts: Record<string, string>
  baseRef?: string
  eventAction?: string
}): RunnerCommand[]
export function parseVitestList(root: string, output: string): string[]
export function parsePlaywrightList(root: string, output: string): string[]
export function collectRunnerFiles(root: string, command: RunnerCommand): string[]
export function auditChangedSpecExecution(options: {
  root: string
  base?: string
  head?: string
  baseRef?: string
  eventAction?: string
  changedPaths?: string[]
  workflows?: WorkflowEntry[]
  packageScripts?: Record<string, string>
  collectFiles?: (root: string, command: RunnerCommand) => string[]
}): ChangedSpecExecutionResult
export declare const NO_NEW_E2E: string
