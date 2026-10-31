#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import picomatch from 'picomatch'
import YAML from 'yaml'

/** Parsed workflow YAML / GitHub JSON: untyped input, validated where each field is read. */
type Parsed = ReturnType<typeof JSON.parse>

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

export interface PathFilterCondition {
  decider: string
  output: string
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

export interface CheckRunSnapshot {
  id: number
  event: string
  name: string
  status: string
  conclusion: string | null
  /** A successful decider's published outputs (see JOB_OUTPUTS_MARKER). */
  outputs?: Record<string, string>
}

interface SkippedCheckRun {
  id: number
  checkSuiteId: number | null
  reason: string
}

/** associateCheckRunEvents' result carries what it skipped as non-enumerable properties. */
type CheckRunSnapshots = CheckRunSnapshot[] & {
  skippedCheckRuns?: SkippedCheckRun[]
  checkRunCount?: number
  suiteEventCount?: number
}

export interface SnapshotClassification {
  state: 'RED' | 'WAIT' | 'INCOMPLETE' | 'COMPLETE'
  missing: string[]
  pending: string[]
  failed: string[]
  successful: string[]
  skippedNotDue: string[]
  ignoredNotApplicable: string[]
  skippedCheckRuns: SkippedCheckRun[]
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
  skippedCheckRuns?: SkippedCheckRun[]
  mergeState?: { mergeable: string; mergeStateStatus: string }
  diagnostic?: string
}

export interface PullRequestEventInput {
  root: string
  sha: string
  number: number
  pull: { base?: { ref?: string; sha?: string } }
  files: string[]
  filesSource?: 'git' | 'github-api'
  action?: string
}

type Annotation = { title?: string | null; message?: string | null }

const DEFAULT_PULL_REQUEST_ACTIONS = new Set(['opened', 'reopened', 'synchronize'])
const EXEC_JSON_MAX_BUFFER = 64 * 1024 * 1024
/**
 * GitHub 的 "List pull requests files" 接口上限:`Responses include a maximum of 3000 files`
 * (REST 文档,2026-08-08 核对)。到达即说明分页也拿不全,手里的清单不是全量。
 * push 事件不受此限 —— 那条路径读的是本地 `git diff`。
 */
export const GITHUB_PR_FILES_API_CAP: number = 3000
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'pending', 'requested', 'waiting'])
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

export function requireExactSha(value: unknown, label: string): string {
  const sha = requireString(value, label)
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`${label} must be a 40-character hexadecimal SHA; use git rev-parse <ref>`)
  }
  return sha
}

function stringList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new Error(`${label} must be a non-empty string array`)
  }
  return value
}

function triggerConfig(workflow: Parsed, eventType: string): Parsed {
  const trigger = workflow?.on
  if (typeof trigger === 'string') return trigger === eventType ? {} : undefined
  if (Array.isArray(trigger)) return trigger.includes(eventType) ? {} : undefined
  if (!trigger || typeof trigger !== 'object' || !(eventType in trigger)) return undefined
  return trigger[eventType] ?? {}
}

function orderedMatch(value: string, patterns: unknown, label: string): boolean {
  let matched = false
  for (const entry of stringList(patterns, label)) {
    const negated = entry.startsWith('!')
    const pattern = negated ? entry.slice(1) : entry
    if (!pattern) throw new Error(`${label} contains an empty negated pattern`)
    if (picomatch.isMatch(value, pattern, { dot: true })) matched = !negated
  }
  return matched
}

function ignoredBy(value: string, patterns: unknown, label: string): boolean {
  return stringList(patterns, label).some((pattern) => {
    if (pattern.startsWith('!')) throw new Error(`${label} cannot contain negated patterns`)
    return picomatch.isMatch(value, pattern, { dot: true })
  })
}

function matchesChangedPaths(config: Parsed, event: VerdictEvent, label: string): boolean {
  if (config.paths === undefined && config['paths-ignore'] === undefined) return true
  if (config.paths !== undefined && config['paths-ignore'] !== undefined) {
    throw new Error(`${label} cannot declare both paths and paths-ignore`)
  }
  if (event.type === 'push' && event.ref!.startsWith('refs/tags/')) return true
  if (!Array.isArray(event.changedPaths)) {
    throw new Error(`${label} needs exact changed paths`)
  }
  // push 事件的清单来自本地 `git diff`(永远全量);pull_request 的来自 files API,而那个
  // 接口**最多返回 3000 个文件**(REST 文档:"Responses include a maximum of 3000 files"),
  // 到顶就意味着我们手里的不是全量,再算下去就是猜 —— 那种情况按铁律 fail loud。
  //
  // 从前这道门槛写的是 300,理由是「GitHub 只列前 300 个」。300 是 GitHub **早已提高**的旧
  // 限额,于是任何超过 300 文件的 PR 都拿不到裁决;而 CLAUDE.md 规定放行只认这个工具的 GREEN,
  // 等于把大 PR(如 dev → main promotion)锁死。实证:#3198 改了 1585 个文件,
  // `schema-baseline.yml` 过滤 `supabase/migrations/**` 且第一个匹配排在第 1349 位,
  // GitHub 照样触发了它 —— 3000 以下按精确算就是对的,不需要任何近似。
  if (event.type !== 'push' && event.changedPathsSource !== 'git' && event.changedPaths.length >= GITHUB_PR_FILES_API_CAP) {
    throw new Error(
      `${label}: PR 改动文件数达到 files API 的 ${GITHUB_PR_FILES_API_CAP} 上限,`
      + '拿到的不是全量清单,无法判定 path filter —— 拒绝在不完整的输入上出裁决。'
    )
  }
  if (config.paths !== undefined) {
    return event.changedPaths.some((file) => orderedMatch(file, config.paths, `${label}.paths`))
  }
  return event.changedPaths.some(
    (file) => !ignoredBy(file, config['paths-ignore'], `${label}.paths-ignore`)
  )
}

function matchesRef(config: Parsed, event: VerdictEvent, label: string): boolean {
  if (event.type === 'push') {
    const tag = event.ref!.startsWith('refs/tags/')
    const name = event.ref!.replace(/^refs\/(?:heads|tags)\//, '')
    const positive = tag ? config.tags : config.branches
    const negative = tag ? config['tags-ignore'] : config['branches-ignore']
    const oppositeDeclared = tag
      ? config.branches !== undefined || config['branches-ignore'] !== undefined
      : config.tags !== undefined || config['tags-ignore'] !== undefined
    if (positive !== undefined && negative !== undefined) {
      throw new Error(`${label} cannot declare both positive and ignore ref filters`)
    }
    if (positive !== undefined) return orderedMatch(name, positive, `${label} ref filter`)
    if (negative !== undefined) return !ignoredBy(name, negative, `${label} ref ignore`)
    return !oppositeDeclared
  }

  if (config.branches !== undefined && config['branches-ignore'] !== undefined) {
    throw new Error(`${label} cannot declare both branches and branches-ignore`)
  }
  if (config.branches !== undefined) {
    return orderedMatch(event.baseRef!, config.branches, `${label}.branches`)
  }
  if (config['branches-ignore'] !== undefined) {
    return !ignoredBy(event.baseRef!, config['branches-ignore'], `${label}.branches-ignore`)
  }
  return true
}

export function workflowRunsForEvent(workflow: Parsed, event: VerdictEvent, label = 'workflow'): boolean {
  const config = triggerConfig(workflow, event.type)
  if (config === undefined) return false
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${label}.${event.type} trigger must be an object or null`)
  }
  if (event.type === 'pull_request' || event.type === 'pull_request_target') {
    const action = requireString(event.action, `${event.id}.action`)
    const actions =
      config.types === undefined
        ? DEFAULT_PULL_REQUEST_ACTIONS
        : new Set(stringList(config.types, `${label}.${event.type}.types`))
    if (!actions.has(action)) return false
  } else if (config.types !== undefined) {
    throw new Error(`${label}.${event.type}.types is unsupported`)
  }
  return (
    matchesRef(config, event, `${label}.${event.type}`) &&
    matchesChangedPaths(config, event, `${label}.${event.type}`)
  )
}

function workflowMatchesEventWithoutPaths(workflow: Parsed, event: VerdictEvent, label = 'workflow'): boolean {
  const config = triggerConfig(workflow, event.type)
  if (config === undefined) return false
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${label}.${event.type} trigger must be an object or null`)
  }
  if (event.type === 'pull_request' || event.type === 'pull_request_target') {
    const action = requireString(event.action, `${event.id}.action`)
    const actions =
      config.types === undefined
        ? DEFAULT_PULL_REQUEST_ACTIONS
        : new Set(stringList(config.types, `${label}.${event.type}.types`))
    if (!actions.has(action)) return false
  } else if (config.types !== undefined) {
    throw new Error(`${label}.${event.type}.types is unsupported`)
  }
  return matchesRef(config, event, `${label}.${event.type}`)
}

/**
 * Does anything in this inventory subscribe to this event at all?
 *
 * GitHub only runs a workflow that asked for the event. `pull_request_target` in a repository
 * that never uses that trigger therefore **never fires** — expecting checks from it is expecting
 * runs that cannot exist. That is a normal repository, not an incomplete one.
 *
 * Refs #4114: the fail-closed rule it added is right for the event that actually fired, and the
 * synthesized `pull_request_target` sibling is not that event. Without this gate every pull
 * request in a repository with no `pull_request_target` workflow reported INCOMPLETE forever,
 * which is the only sanctioned merge verdict saying "never" to the whole repository.
 */
export function eventHasSubscribingWorkflow(event: VerdictEvent): boolean {
  return event.workflows.some((entry) => {
    const workflow = entry.workflow ?? YAML.parse(entry.source)
    return workflowMatchesEventWithoutPaths(workflow, event, `${event.inventoryRef}:${entry.path}`)
  })
}

function matrixAssignments(job: Parsed, label: string): Record<string, unknown>[] {
  const matrix = job?.strategy?.matrix
  if (matrix === undefined) return [{}]
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    throw new Error(`${label} matrix must be a static object`)
  }
  if (matrix.exclude !== undefined) {
    throw new Error(`${label} matrix exclude cannot be expanded safely`)
  }
  if (matrix.include !== undefined) {
    const axes = Object.keys(matrix).filter((key) => key !== 'include')
    if (axes.length > 0) {
      throw new Error(`${label} matrix cannot mix include with cartesian axes`)
    }
    if (!Array.isArray(matrix.include) || matrix.include.length === 0) {
      throw new Error(`${label} matrix include must be a non-empty array`)
    }
    return matrix.include.map((assignment: Parsed, index: number) => {
      if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
        throw new Error(`${label} matrix include[${index}] must be a static object`)
      }
      for (const [name, value] of Object.entries(assignment)) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
          throw new Error(`${label} matrix include[${index}].${name} must be a scalar`)
        }
      }
      return assignment
    })
  }
  let assignments: Record<string, unknown>[] = [{}]
  for (const [name, values] of Object.entries(matrix)) {
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => !['string', 'number', 'boolean'].includes(typeof value))
    ) {
      throw new Error(`${label} matrix ${name} must be a non-empty scalar array`)
    }
    assignments = assignments.flatMap((assignment) =>
      values.map((value) => ({ ...assignment, [name]: value }))
    )
  }
  return assignments
}

function expandJobName(template: string, assignment: Record<string, unknown>, label: string): string {
  const expanded = template.replace(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/g, (_, key: string) => {
    if (!(key in assignment)) throw new Error(`${label} references unknown matrix key ${key}`)
    return String(assignment[key])
  })
  if (expanded.includes('${{')) {
    throw new Error(`${label} has a dynamic check name that cannot be derived`)
  }
  return requireString(expanded, label)
}

/**
 * @@@path-filtered-jobs — a job may be skipped by design: its `if:` is exactly
 * `needs.<decider>.outputs.<key> == 'true'`, and the decider job (ci.yml's `changes`) decides
 * from the changed paths whether it is due. The decider publishes the outputs it acted on as one
 * check-run annotation titled JOB_OUTPUTS_MARKER, message `key=value key=value ...`, so this
 * verdict reads the same decision the workflow used instead of re-deriving it.
 *
 * A skipped run of such a job counts as passed only when the decider succeeded and published
 * `<key>=false`. Every other skip — decider said due, failed, is still running, or published no
 * marker — stays non-green. Jobs whose `if:` has any other shape keep the old rule: skipped = RED.
 */
export const JOB_OUTPUTS_MARKER: string = 'ci-job-outputs'
const PATH_FILTER_IF =
  /^\s*(?:\$\{\{\s*)?needs\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)\s*==\s*'true'\s*(?:\}\})?\s*$/

function pathFilterCondition(workflow: Parsed, jobId: string, job: Parsed, label: string): PathFilterCondition | undefined {
  if (typeof job.if !== 'string') return undefined
  const match = PATH_FILTER_IF.exec(job.if)
  if (!match) return undefined
  const [, deciderId, output] = match
  const needs = typeof job.needs === 'string' ? [job.needs] : (job.needs ?? [])
  const decider = workflow.jobs[deciderId]
  if (!needs.includes(deciderId) || !decider || typeof decider !== 'object') {
    throw new Error(`${label} job ${jobId} is conditioned on job ${deciderId} without needing it`)
  }
  if (decider.strategy?.matrix !== undefined) {
    throw new Error(`${label} job ${jobId} is conditioned on matrix job ${deciderId}`)
  }
  return {
    decider: expandJobName(String(decider.name ?? deciderId), {}, `${label} job ${deciderId} name`),
    output
  }
}

/** The decider's outputs from its check-run annotations; undefined unless exactly one valid marker. */
export function parseJobOutputsAnnotations(annotations: Annotation[]): Record<string, string> | undefined {
  if (!Array.isArray(annotations)) throw new Error('annotations must be an array')
  const markers = annotations.filter((annotation) => annotation?.title === JOB_OUTPUTS_MARKER)
  if (markers.length !== 1 || typeof markers[0].message !== 'string') return undefined
  const outputs: Record<string, string> = {}
  for (const token of markers[0].message.trim().split(/\s+/)) {
    const match = /^([A-Za-z_][\w-]*)=(\S*)$/.exec(token)
    if (!match || match[1] in outputs) return undefined
    outputs[match[1]] = match[2]
  }
  return outputs
}

/**
 * Attach the published outputs to every successful decider run the profiles rely on.
 * `fetchAnnotations(checkRunId)` returns that check run's annotations.
 */
export function attachDeciderOutputs<T extends CheckRunSnapshot>(
  checkRuns: T[],
  profiles: CheckProfile[],
  fetchAnnotations: (checkRunId: number) => Annotation[],
): T[] {
  const deciders = new Set<string>()
  for (const profile of profiles) {
    for (const condition of Object.values(profile.pathFiltered ?? {})) {
      deciders.add(`${profile.eventType}\0${condition.decider}`)
    }
  }
  for (const run of checkRuns) {
    if (!deciders.has(`${run.event}\0${run.name}`)) continue
    if (run.status !== 'completed' || run.conclusion !== 'success') continue
    run.outputs = parseJobOutputsAnnotations(fetchAnnotations(run.id))
  }
  return checkRuns
}

function inventoryDigest(entries: WorkflowEntry[]): string {
  const hash = createHash('sha256')
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(entry.path)
    hash.update('\0')
    hash.update(entry.source)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function deriveCheckProfiles(events: VerdictEvent[]): CheckProfile[] {
  if (!Array.isArray(events) || events.length === 0)
    throw new Error('at least one event is required')
  const eventTypes = new Set<string>()
  const profiles: CheckProfile[] = []
  const expectedKeys = new Map<string, string>()
  for (const event of events) {
    requireString(event.id, 'event.id')
    requireString(event.type, `${event.id}.type`)
    requireString(event.inventoryRef, `${event.id}.inventoryRef`)
    if (event.type === 'push') requireString(event.ref, `${event.id}.ref`)
    if (event.type === 'pull_request' || event.type === 'pull_request_target') {
      requireString(event.baseRef, `${event.id}.baseRef`)
    }
    if (eventTypes.has(event.type)) {
      throw new Error(
        `multiple ${event.type} events cannot be matched to check suites unambiguously`
      )
    }
    eventTypes.add(event.type)
    if (!Array.isArray(event.workflows)) throw new Error(`${event.id}.workflows must be an array`)

    const generation = inventoryDigest(event.workflows)
    let matchedWorkflows = 0
    let eventMatchedWorkflows = 0
    for (const entry of event.workflows) {
      const workflow: Parsed = entry.workflow ?? YAML.parse(entry.source)
      const label = `${event.inventoryRef}:${entry.path}`
      if (workflowMatchesEventWithoutPaths(workflow, event, label)) eventMatchedWorkflows += 1
      if (!workflowRunsForEvent(workflow, event, label)) continue
      matchedWorkflows += 1
      if (!workflow.jobs || typeof workflow.jobs !== 'object' || Array.isArray(workflow.jobs)) {
        throw new Error(`${label}.jobs must be an object`)
      }
      const checks: string[] = []
      const pathFiltered: Record<string, PathFilterCondition> = {}
      for (const [jobId, job] of Object.entries<Parsed>(workflow.jobs)) {
        if (!job || typeof job !== 'object' || Array.isArray(job)) {
          throw new Error(`${label} job ${jobId} must be an object`)
        }
        if (job.uses !== undefined) {
          throw new Error(
            `${label} job ${jobId} uses a reusable workflow with non-local check names`
          )
        }
        const template = job.name ?? jobId
        const condition = pathFilterCondition(workflow, jobId, job, label)
        for (const assignment of matrixAssignments(job, `${label} job ${jobId}`)) {
          const name = expandJobName(String(template), assignment, `${label} job ${jobId} name`)
          const key = `${event.type}\0${name}`
          const previous = expectedKeys.get(key)
          if (previous) {
            throw new Error(
              `ambiguous check ${JSON.stringify(name)} for ${event.type}: ${previous} and ${entry.path}`
            )
          }
          expectedKeys.set(key, entry.path)
          checks.push(name)
          if (condition) pathFiltered[name] = condition
        }
      }
      profiles.push({
        eventId: event.id,
        eventType: event.type,
        inventoryRef: event.inventoryRef,
        generation,
        workflow: entry.path,
        checks: checks.sort(),
        pathFiltered
      })
    }
    if (matchedWorkflows === 0) {
      profiles.push({
        eventId: event.id,
        eventType: event.type,
        inventoryRef: event.inventoryRef,
        generation,
        workflow: null,
        checks: [],
        noMatchReason: eventMatchedWorkflows === 0 ? 'event' : 'paths'
      })
    }
  }
  return profiles
}

function latestRunsByKey(checkRuns: CheckRunSnapshot[]): Map<string, CheckRunSnapshot> {
  if (!Array.isArray(checkRuns)) throw new Error('checkRuns must be an array')
  const latest = new Map<string, CheckRunSnapshot>()
  for (const run of checkRuns) {
    const event = requireString(run.event, 'check run event')
    const name = requireString(run.name, 'check run name')
    const id = Number(run.id)
    if (!Number.isFinite(id)) throw new Error(`${event}/${name} check run id must be numeric`)
    const key = `${event}\0${name}`
    if (!latest.has(key) || Number(latest.get(key)!.id) < id) latest.set(key, run)
  }
  return latest
}

export function classifyCheckSnapshot(profiles: CheckProfile[], checkRuns: CheckRunSnapshots): SnapshotClassification {
  const expected = new Map<string, { profile: CheckProfile; name: string }>()
  for (const profile of profiles) {
    for (const name of profile.checks)
      expected.set(`${profile.eventType}\0${name}`, { profile, name })
  }
  const latest = latestRunsByKey(checkRuns)
  const missing: string[] = []
  const pending: string[] = []
  const failed: string[] = []
  const successful: string[] = []
  const skippedNotDue: string[] = []
  for (const [key, item] of expected) {
    const run = latest.get(key)
    const label = `${item.profile.eventType}/${item.name}`
    if (!run) {
      missing.push(label)
      continue
    }
    const status = requireString(run.status, `${label} status`).toLowerCase()
    if (PENDING_STATUSES.has(status)) {
      pending.push(label)
      continue
    }
    if (status !== 'completed')
      throw new Error(`${label} has unknown status ${JSON.stringify(status)}`)
    const conclusion = typeof run.conclusion === 'string' ? run.conclusion.toLowerCase() : null
    const condition = item.profile.pathFiltered?.[item.name]
    if (conclusion === 'success') successful.push(label)
    else if (conclusion === 'skipped' && condition) {
      // @@@path-filtered-jobs — see JOB_OUTPUTS_MARKER.
      const decider = latest.get(`${item.profile.eventType}\0${condition.decider}`)
      const deciderStatus = typeof decider?.status === 'string' ? decider.status.toLowerCase() : null
      const deciderConclusion =
        typeof decider?.conclusion === 'string' ? decider.conclusion.toLowerCase() : null
      const due = decider?.outputs?.[condition.output]
      if (!decider) missing.push(label)
      else if (PENDING_STATUSES.has(deciderStatus!)) pending.push(label)
      else if (deciderConclusion !== 'success')
        failed.push(`${label} (skipped; ${condition.decider} ${deciderConclusion ?? 'missing conclusion'})`)
      else if (due === 'false') {
        successful.push(label)
        skippedNotDue.push(label)
      } else if (due === undefined)
        failed.push(`${label} (skipped; ${condition.decider} published no ${JOB_OUTPUTS_MARKER} ${condition.output})`)
      else failed.push(`${label} (skipped although ${condition.decider} reported ${condition.output}=${due})`)
    } else failed.push(`${label} (${conclusion ?? 'missing conclusion'})`)
  }

  const ignoredNotApplicable = [...latest]
    .filter(([key]) => !expected.has(key))
    .map(([, run]) => `${run.event}/${run.name}`)
    .sort()
  const state: SnapshotClassification['state'] =
    failed.length > 0
      ? 'RED'
      : pending.length > 0
        ? 'WAIT'
        : profiles.some((profile) => profile.noMatchReason === 'event')
          ? 'INCOMPLETE'
        : missing.length > 0
          ? 'INCOMPLETE'
          : 'COMPLETE'
  return {
    state,
    missing: missing.sort(),
    pending: pending.sort(),
    failed: failed.sort(),
    successful: successful.sort(),
    skippedNotDue: skippedNotDue.sort(),
    ignoredNotApplicable,
    skippedCheckRuns: checkRuns.skippedCheckRuns ?? [],
    fingerprint:
      state === 'COMPLETE'
        ? successful
            .map((label) => {
              const [event, ...name] = label.split('/')
              const run = latest.get(`${event}\0${name.join('/')}`)
              return `${label}:${run!.id}`
            })
            .sort()
            .join('|')
        : null
  }
}

export function evaluateCheckSnapshots(profiles: CheckProfile[], snapshots: CheckRunSnapshots[]): CheckVerdict {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error('at least one check-run snapshot is required')
  }
  const latestRuns = snapshots.at(-1)!
  const latest = classifyCheckSnapshot(profiles, latestRuns)
  let verdict: CheckVerdict['verdict'] = latest.state === 'COMPLETE' ? 'WAIT' : latest.state
  let settling = false
  if (latest.state === 'COMPLETE') {
    const previous = snapshots.length > 1 ? classifyCheckSnapshot(profiles, snapshots.at(-2)!) : null
    if (previous?.state === 'COMPLETE' && previous.fingerprint === latest.fingerprint)
      verdict = 'GREEN'
    else {
      verdict = 'WAIT'
      settling = true
    }
  }
  return {
    verdict,
    settling,
    generations: [
      ...new Map(
        profiles.map((profile) => [
          `${profile.eventType}\0${profile.inventoryRef}`,
          {
            event: profile.eventType,
            inventoryRef: profile.inventoryRef,
            sha256: profile.generation
          }
        ])
      ).values()
    ],
    profiles: profiles.map((profile) => ({
      event: profile.eventType,
      workflow: profile.workflow,
      checks: profile.checks,
      ...(profile.noMatchReason ? { noMatchReason: profile.noMatchReason } : {})
    })),
    missing: latest.missing,
    pending: latest.pending,
    failed: latest.failed,
    ignoredNotApplicable: latest.ignoredNotApplicable,
    ...(latest.skippedNotDue.length > 0 ? { skippedNotDue: latest.skippedNotDue } : {}),
    ...(latest.skippedCheckRuns.length > 0
      ? {
          skippedCheckRuns: latest.skippedCheckRuns,
          diagnostic:
            latestRuns.checkRunCount! > 0 && latestRuns.suiteEventCount === 0
              ? `found ${latestRuns.checkRunCount} GitHub Actions check run(s), but no workflow run ` +
                `matched the exact SHA; suite-to-event mapping is empty: ${latest.skippedCheckRuns
                  .map((run) => `${run.id} (suite ${run.checkSuiteId ?? 'unknown'})`)
                  .join(', ')}`
              : `skipped ${latest.skippedCheckRuns.length} GitHub Actions check run(s) without ` +
                `a matching workflow event: ${latest.skippedCheckRuns
                  .map((run) => `${run.id} (suite ${run.checkSuiteId ?? 'unknown'})`)
                  .join(', ')}`
        }
      : {})
  }
}

/**
 * A pull request with no matching workflow event has no checks to settle. That
 * shape is different from a legitimate path-filter exclusion: the former can
 * be caused by a DIRTY/CONFLICTING PR that cannot produce a merge ref, while
 * the latter is an intentional not-applicable profile.
 */
export function shouldReadPullRequestMergeState(result: CheckVerdict): boolean {
  return (
    result?.verdict === 'INCOMPLETE' &&
    Array.isArray(result.missing) &&
    result.missing.length === 0 &&
    Array.isArray(result.pending) &&
    result.pending.length === 0 &&
    Array.isArray(result.failed) &&
    result.failed.length === 0 &&
    Array.isArray(result.profiles) &&
    result.profiles.some((profile) => profile.noMatchReason === 'event')
  )
}

export function attachPullRequestMergeState(
  result: CheckVerdict,
  mergeState: { mergeable: string; mergeStateStatus: string },
): CheckVerdict {
  if (!shouldReadPullRequestMergeState(result)) return result
  const mergeable = requireString(mergeState?.mergeable, 'pull request mergeable')
  const mergeStateStatus = requireString(
    mergeState?.mergeStateStatus,
    'pull request mergeStateStatus'
  )
  return {
    ...result,
    mergeState: { mergeable, mergeStateStatus },
    diagnostic:
      `pull-request event has no registered checks; mergeable=${mergeable} ` +
      `mergeStateStatus=${mergeStateStatus}. Resolve the PR merge state before treating ` +
      'the missing-check result as a CI scheduling question.'
  }
}

function execJson(command: string, args: string[], options: { cwd?: string; jsonLines?: boolean } = {}): Parsed {
  const { jsonLines = false, ...execOptions } = options
  const output = execFileSync(command, args, {
    ...execOptions,
    encoding: 'utf8',
    maxBuffer: EXEC_JSON_MAX_BUFFER
  })
  try {
    if (!jsonLines) return JSON.parse(output)
    const lines = output.endsWith('\n') ? output.slice(0, -1).split('\n') : output.split('\n')
    if (lines.length === 0 || lines.some((line) => line.length === 0)) {
      throw new Error('JSON-lines output contains an empty line')
    }
    return lines.map((line) => JSON.parse(line))
  } catch (error) {
    throw new Error(`${command} returned invalid JSON: ${(error as Error).message}`)
  }
}

export function loadWorkflowInventory(
  root: string,
  ref: string,
  execute: (command: string, args: string[], options: { cwd: string; encoding?: BufferEncoding }) => string | Buffer = execFileSync,
): WorkflowEntry[] {
  const output = execute(
    'git',
    ['ls-tree', '-r', '-z', '--name-only', ref, '--', '.github/workflows'],
    { cwd: root }
  ).toString('utf8')
  const workflowPaths = output
    .split('\0')
    .filter((file) => WORKFLOW_PATH.test(file))
    .sort()
  if (workflowPaths.length === 0) throw new Error(`${ref} has no workflow inventory`)
  return workflowPaths.map((workflowPath) => ({
    path: workflowPath,
    source: execute('git', ['show', `${ref}:${workflowPath}`], {
      cwd: root,
      encoding: 'utf8'
    }).toString()
  }))
}

function changedPaths(root: string, base: string, head: string): string[] {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', '-z', base, head],
    { cwd: root }
  ).toString('utf8')
  return output
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'))
}

function ghPages(endpoint: string, field: string, root: string): Parsed[] {
  const gh = process.env.GUGU_GH || 'gh'
  const pages = execJson(gh, ['api', '--paginate', '--slurp', endpoint], { cwd: root })
  if (!Array.isArray(pages)) throw new Error(`${endpoint} did not return pages`)
  return pages.flatMap((page: Parsed) => {
    if (!page || typeof page !== 'object' || !Array.isArray(page[field])) {
      throw new Error(`${endpoint} page is missing ${field}`)
    }
    return page[field]
  })
}

/**
 * The events a pull request is judged against.
 *
 * `pull_request` is what actually fires. `pull_request_target` is **synthesized** here so that a
 * repository which does use that trigger has its checks expected too — and it is only added when
 * the base branch actually subscribes to it. GitHub never runs a workflow that did not ask for the
 * event, so in a repository with no `pull_request_target` workflow that event produces no runs;
 * expecting a profile from it is expecting runs that cannot exist.
 *
 * Refs #4114: that PR made "no workflow matches this event" fail closed, which is right for the
 * event that fired and wrong for this synthesized sibling. Without the gate below, every pull
 * request in this repository reported INCOMPLETE — the only sanctioned merge verdict saying
 * "never" to the whole repository, for an hour, until someone read the profile output.
 *
 * `loadInventory` is injectable so the gate itself is testable without a repository that happens
 * to have (or not have) a `pull_request_target` workflow.
 */
export function pullRequestEvents(
  { root, sha, number, pull, files, filesSource, action }: PullRequestEventInput,
  loadInventory: (root: string, ref: string) => WorkflowEntry[] = loadWorkflowInventory
): VerdictEvent[] {
  const common = {
    action,
    baseRef: requireString(pull.base?.ref, `PR #${number} base ref`),
    changedPaths: files,
    changedPathsSource: filesSource
  }
  const events: VerdictEvent[] = [
    {
      ...common,
      id: `pull_request:#${number}`,
      type: 'pull_request',
      inventoryRef: sha,
      workflows: loadInventory(root, sha)
    }
  ]
  const baseSha = requireString(pull.base?.sha, `PR #${number} base sha`)
  const targetEvent: VerdictEvent = {
    ...common,
    id: `pull_request_target:#${number}`,
    type: 'pull_request_target',
    inventoryRef: baseSha,
    workflows: loadInventory(root, baseSha)
  }
  if (eventHasSubscribingWorkflow(targetEvent)) events.push(targetEvent)
  return events
}

const SKIPPED_CHECK_RUNS = 'skippedCheckRuns'

export function associateCheckRunEvents(
  checkRuns: Array<{
    id: number
    app?: { slug?: string }
    check_suite?: { id?: number }
    name: string
    status: string
    conclusion: string | null
  }>,
  workflowRuns: Array<{ id: number; check_suite_id: number; event: string }>,
): CheckRunSnapshots {
  if (!Array.isArray(checkRuns)) throw new Error('checkRuns must be an array')
  if (!Array.isArray(workflowRuns)) throw new Error('workflowRuns must be an array')
  const suiteEvents = new Map<number, string>()
  for (const run of workflowRuns) {
    const suiteId = Number(run.check_suite_id)
    if (!Number.isFinite(suiteId)) throw new Error(`workflow run ${run.id} has no check_suite_id`)
    const event = requireString(run.event, `workflow run ${run.id} event`)
    const previous = suiteEvents.get(suiteId)
    if (previous && previous !== event) {
      throw new Error(`check suite ${suiteId} maps to both ${previous} and ${event}`)
    }
    suiteEvents.set(suiteId, event)
  }
  const skippedCheckRuns: SkippedCheckRun[] = []
  const associated: CheckRunSnapshots = checkRuns
    .filter((run) => run.app?.slug === 'github-actions')
    .flatMap((run): CheckRunSnapshot[] => {
      const event = suiteEvents.get(Number(run.check_suite?.id))
      if (!event) {
        skippedCheckRuns.push({
          id: run.id,
          checkSuiteId: run.check_suite?.id ?? null,
          reason: 'no-check-suite-event'
        })
        return []
      }
      return [
        {
          id: run.id,
          event,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion
        }
      ]
    })
  Object.defineProperty(associated, SKIPPED_CHECK_RUNS, {
    value: skippedCheckRuns,
    enumerable: false,
    configurable: false
  })
  Object.defineProperties(associated, {
    checkRunCount: {
      value: checkRuns.filter((run) => run.app?.slug === 'github-actions').length,
      enumerable: false,
      configurable: false
    },
    suiteEventCount: {
      value: suiteEvents.size,
      enumerable: false,
      configurable: false
    }
  })
  return associated
}

function ghArrayPages(endpoint: string, root: string): Parsed[] {
  const gh = process.env.GUGU_GH || 'gh'
  const pages = execJson(gh, ['api', '--paginate', '--slurp', endpoint], { cwd: root })
  if (!Array.isArray(pages) || pages.some((page: Parsed) => !Array.isArray(page))) {
    throw new Error(`${endpoint} did not return array pages`)
  }
  return pages.flat()
}

function fetchCheckRuns({ repo, sha, root, profiles }: { repo: string; sha: string; root: string; profiles: CheckProfile[] }): CheckRunSnapshots {
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error('--repo must be OWNER/REPO')
  const workflowRuns = ghPages(
    `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
    'workflow_runs',
    root
  )
  const checkRuns = ghPages(
    `repos/${repo}/commits/${sha}/check-runs?filter=all&per_page=100`,
    'check_runs',
    root
  )
  return attachDeciderOutputs(associateCheckRunEvents(checkRuns, workflowRuns), profiles, (id) =>
    ghArrayPages(`repos/${repo}/check-runs/${id}/annotations?per_page=100`, root)
  )
}

/** A complete Git diff includes both sides of renames; extra paths can only require extra checks. */
export function completePullRequestFiles(
  root: string,
  pull: { base?: { sha?: string }; head?: { sha?: string }; changed_files?: number },
  apiFiles: string[],
): string[] {
  const base = requireExactSha(pull.base?.sha, 'PR base sha')
  const head = requireExactSha(pull.head?.sha, 'PR head sha')
  if (!Number.isSafeInteger(pull.changed_files) || pull.changed_files! < apiFiles.length) {
    throw new Error('PR changed_files must cover the API file list')
  }
  const files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`], {
    cwd: root,
    maxBuffer: EXEC_JSON_MAX_BUFFER
  }).toString('utf8').split('\0').filter(Boolean)
  const names = new Set(files)
  if (names.size < pull.changed_files! || apiFiles.some((name) => !names.has(name))) {
    throw new Error('Complete Git PR files do not cover the GitHub changed_files count or API file names')
  }
  return files
}

function fetchPullRequest(repo: string, number: number, root: string): { pull: Parsed; files: string[]; filesSource: 'git' | 'github-api' } {
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error('--repo must be OWNER/REPO')
  const gh = process.env.GUGU_GH || 'gh'
  const pull = execJson(gh, ['api', `repos/${repo}/pulls/${number}`], { cwd: root })
  const files = execJson(
    gh,
    [
      'api',
      '--paginate',
      `repos/${repo}/pulls/${number}/files?per_page=100`,
      '--jq',
      'map(.filename)'
    ],
    { cwd: root, jsonLines: true }
  )
  if (!Array.isArray(files) || files.some((page: Parsed) => !Array.isArray(page))) {
    throw new Error(`pull request #${number} files did not return pages`)
  }
  const apiFiles = files.flat().map((file) => requireString(file, 'PR file name'))
  return apiFiles.length >= GITHUB_PR_FILES_API_CAP
    ? { pull, files: completePullRequestFiles(root, pull, apiFiles), filesSource: 'git' }
    : { pull, files: apiFiles, filesSource: 'github-api' }
}

function fetchPullRequestMergeState(repo: string, number: number, root: string): { mergeable: string; mergeStateStatus: string } {
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error('--repo must be OWNER/REPO')
  const gh = process.env.GUGU_GH || 'gh'
  const output = execFileSync(
    gh,
    ['pr', 'view', String(number), '--repo', repo, '--json', 'mergeable,mergeStateStatus'],
    { cwd: root, encoding: 'utf8', maxBuffer: EXEC_JSON_MAX_BUFFER }
  )
  try {
    const state = JSON.parse(output)
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('merge state response must be an object')
    }
    return state
  } catch (error) {
    throw new Error(`pull request #${number} merge state returned invalid JSON: ${(error as Error).message}`)
  }
}

function positiveSeconds(value: string | undefined, label: string, fallback: number): number {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive`)
  return number
}

function printResult(result: CheckVerdict, asJson: boolean | undefined): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  console.log(result.verdict)
  for (const key of [
    'generations',
    'profiles',
    'missing',
    'pending',
    'failed',
    'ignoredNotApplicable',
    'skippedNotDue',
    'skippedCheckRuns',
    'mergeState',
    'diagnostic'
  ]) {
    const value = result[key as keyof CheckVerdict]
    if (value !== undefined) console.log(`${key}: ${JSON.stringify(value)}`)
  }
}

function verdictExitCode(verdict: CheckVerdict['verdict']): number {
  if (verdict === 'GREEN') return 0
  if (verdict === 'RED') return 1
  return 2
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: 'OpenDCAI/gugu' },
      sha: { type: 'string' },
      push: { type: 'string' },
      before: { type: 'string' },
      pr: { type: 'string' },
      action: { type: 'string', default: 'synchronize' },
      fixture: { type: 'string' },
      watch: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'interval-seconds': { type: 'string' },
      'settle-seconds': { type: 'string' },
      'timeout-seconds': { type: 'string' }
    },
    allowPositionals: false
  })

  if (values.fixture) {
    const fixture = JSON.parse(readFileSync(values.fixture, 'utf8'))
    const profiles = deriveCheckProfiles(fixture.events)
    const result = evaluateCheckSnapshots(profiles, fixture.snapshots)
    printResult(result, values.json)
    process.exitCode = verdictExitCode(result.verdict)
    return
  }

  const root = process.cwd()
  const sha = requireExactSha(values.sha, '--sha')
  const before =
    values.before === undefined ? undefined : requireExactSha(values.before, '--before')
  const events: VerdictEvent[] = []
  if (values.push) {
    events.push({
      id: `push:${values.push}`,
      type: 'push',
      ref: `refs/heads/${values.push}`,
      changedPaths: changedPaths(root, before ?? `${sha}^`, sha),
      inventoryRef: sha,
      workflows: loadWorkflowInventory(root, sha)
    })
  }
  if (values.pr) {
    const number = Number(values.pr)
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error('--pr must be a positive integer')
    const { pull, files, filesSource } = fetchPullRequest(values.repo!, number, root)
    if (pull.head?.sha !== sha) {
      throw new Error(
        `PR #${number} head ${pull.head?.sha ?? '<missing>'} does not equal --sha ${sha}`
      )
    }
    events.push(...pullRequestEvents({ root, sha, number, pull, files, filesSource, action: values.action }))
  }
  const profiles = deriveCheckProfiles(events)
  const formatResult = (result: CheckVerdict): CheckVerdict => {
    const base = { sha, ...result }
    if (values.pr && shouldReadPullRequestMergeState(result)) {
      return attachPullRequestMergeState(
        base,
        fetchPullRequestMergeState(values.repo!, Number(values.pr), root)
      )
    }
    return base
  }
  const intervalMs = positiveSeconds(values['interval-seconds'], '--interval-seconds', 15) * 1000
  const settleMs = positiveSeconds(values['settle-seconds'], '--settle-seconds', 15) * 1000
  const timeoutMs = positiveSeconds(values['timeout-seconds'], '--timeout-seconds', 3600) * 1000
  const deadline = Date.now() + timeoutMs
  const snapshots: CheckRunSnapshots[] = []

  for (;;) {
    snapshots.push(fetchCheckRuns({ repo: values.repo!, sha, root, profiles }))
    if (snapshots.length > 2) snapshots.shift()
    const result = evaluateCheckSnapshots(profiles, snapshots)
    if (result.verdict === 'RED' || result.verdict === 'GREEN' || !values.watch) {
      if (result.settling && !values.watch) {
        await new Promise((resolve) => setTimeout(resolve, settleMs))
        snapshots.push(fetchCheckRuns({ repo: values.repo!, sha, root, profiles }))
        if (snapshots.length > 2) snapshots.shift()
        const settled = evaluateCheckSnapshots(profiles, snapshots)
        printResult(formatResult(settled), values.json)
        process.exitCode = verdictExitCode(settled.verdict)
      } else {
        printResult(formatResult(result), values.json)
        process.exitCode = verdictExitCode(result.verdict)
      }
      return
    }
    if (Date.now() >= deadline) {
      printResult(formatResult(result), values.json)
      process.exitCode = verdictExitCode(result.verdict)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, result.settling ? settleMs : intervalMs))
  }
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (isEntrypoint) {
  main().catch((error) => {
    console.error(`CONFIG_ERROR: ${error.message}`)
    process.exitCode = 1
  })
}
