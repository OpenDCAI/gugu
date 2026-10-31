export interface WorkflowEntry {
  path: string
  source: string
  workflow?: Record<string, unknown>
}

export interface VerdictEvent {
  id: string
  type: string
  action?: string
  ref?: string
  baseRef?: string
  changedPaths: string[]
  changedPathsSource?: 'git' | 'github-api'
  inventoryRef: string
  workflows: WorkflowEntry[]
}

export interface CheckProfile {
  eventId: string
  eventType: string
  inventoryRef: string
  generation: string
  workflow: string | null
  checks: string[]
  /** Checks a decider job may skip by design: check name -> decider check name and its output key. */
  pathFiltered?: Record<string, PathFilterCondition>
  noMatchReason?: 'event' | 'paths'
}

export interface PathFilterCondition {
  decider: string
  output: string
}

export interface CheckRunSnapshot {
  id: number
  event: string
  name: string
  status: string
  conclusion: string | null
  /** A successful decider's published outputs (see JOB_OUTPUTS_MARKER). */
  outputs?: Record<string, string>
}

export interface SnapshotClassification {
  state: 'RED' | 'WAIT' | 'INCOMPLETE' | 'COMPLETE'
  missing: string[]
  pending: string[]
  failed: string[]
  successful: string[]
  skippedNotDue: string[]
  ignoredNotApplicable: string[]
  fingerprint: string | null
}

export interface CheckVerdict {
  sha?: string
  verdict: 'RED' | 'WAIT' | 'INCOMPLETE' | 'GREEN'
  settling: boolean
  generations: Array<{ event: string; inventoryRef: string; sha256: string }>
  profiles: Array<{
    event: string
    workflow: string | null
    checks: string[]
    noMatchReason?: 'event' | 'paths'
  }>
  missing: string[]
  pending: string[]
  failed: string[]
  ignoredNotApplicable: string[]
  skippedNotDue?: string[]
  skippedCheckRuns?: Array<{ id: number; checkSuiteId: number | null; reason: string }>
  mergeState?: { mergeable: string; mergeStateStatus: string }
  diagnostic?: string
}

/** GitHub PR files API 的 3000 文件上限;到达即说明拿到的不是全量清单。 */
export const GITHUB_PR_FILES_API_CAP: number

/** Title of the check-run annotation in which a decider job publishes its outputs (`key=value ...`). */
export const JOB_OUTPUTS_MARKER: string

export function parseJobOutputsAnnotations(
  annotations: Array<{ title?: string | null; message?: string | null }>
): Record<string, string> | undefined

export function attachDeciderOutputs<T extends CheckRunSnapshot>(
  checkRuns: T[],
  profiles: CheckProfile[],
  fetchAnnotations: (checkRunId: number) => Array<{ title?: string | null; message?: string | null }>
): T[]

export function requireExactSha(value: unknown, label: string): string

export function workflowRunsForEvent(
  workflow: Record<string, unknown>,
  event: VerdictEvent,
  label?: string
): boolean

/** 这份 inventory 里有没有 workflow 订阅了这个事件（忽略 paths 过滤）。 */
export function eventHasSubscribingWorkflow(event: VerdictEvent): boolean

export interface PullRequestEventInput {
  root: string
  sha: string
  number: number
  pull: { base?: { ref?: string; sha?: string } }
  files: string[]
  filesSource?: 'git' | 'github-api'
  action?: string
}

/** PR 要被判定的事件集：pull_request 必有，pull_request_target 只在 base 真订阅时才合成。 */
export function pullRequestEvents(
  input: PullRequestEventInput,
  loadInventory?: (root: string, ref: string) => WorkflowEntry[]
): VerdictEvent[]

export function completePullRequestFiles(
  root: string,
  pull: { base?: { sha?: string }; head?: { sha?: string }; changed_files?: number },
  apiFiles: string[]
): string[]

export function deriveCheckProfiles(events: VerdictEvent[]): CheckProfile[]

export function classifyCheckSnapshot(
  profiles: CheckProfile[],
  checkRuns: CheckRunSnapshot[]
): SnapshotClassification

export function evaluateCheckSnapshots(
  profiles: CheckProfile[],
  snapshots: CheckRunSnapshot[][]
): CheckVerdict

export function shouldReadPullRequestMergeState(result: CheckVerdict): boolean

export function attachPullRequestMergeState(
  result: CheckVerdict,
  mergeState: { mergeable: string; mergeStateStatus: string }
): CheckVerdict

export function associateCheckRunEvents(
  checkRuns: Array<{
    id: number
    app?: { slug?: string }
    check_suite?: { id?: number }
    name: string
    status: string
    conclusion: string | null
  }>,
  workflowRuns: Array<{ id: number; check_suite_id: number; event: string }>
): CheckRunSnapshot[]

export function loadWorkflowInventory(root: string, ref: string): WorkflowEntry[]
export function loadWorkflowInventory(
  root: string,
  ref: string,
  execute: (
    command: string,
    args: string[],
    options: { cwd: string; encoding?: string }
  ) => string | Buffer
): WorkflowEntry[]
