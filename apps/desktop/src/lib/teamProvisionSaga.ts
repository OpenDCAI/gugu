import {
  assertMemberNotCancelOnly,
  assertResumeRecordOwner,
  buildTeamBlueprint,
  cancelProvisionOperation,
  claimProvisionSlots,
  defaultRemoveOwnedAgent,
  defaultStopAgentRuntime,
  clientSourceDigest,
  defaultEnsureDeviceOnline,
  defaultResumeStore,
  finalizeAgentTeam,
  getProvisionOperation,
  listOperationMembers,
  newProvisionId,
  runClaimedMember,
  settleProvisionCancellation,
  startProvisionOperation,
  type ProvisionResumeMemberRef,
  type ProvisionResumeRecord,
  type ProvisionResumeStore,
  type ProvisionRuntimeDeps,
} from './agentProvision'
import { getCurrentAuthUserId } from './supabase'
import { clearCancelledStarter } from './starterContinuation'
import type {
  AgentHistoryImportInput,
  AgentMemoryContentInput,
  AgentMemorySource,
  AgentProvision,
  AgentProvisionHistorySourceRef,
  AgentProvisionMemberInput,
  AgentProvisionMemberOutcome,
  AgentProvisionOperation,
} from '@gugu/core/shared/types/agentProvision'

// #2260 — team provisioning SAGA. Orchestrates N members over the SAME shared single-member primitive:
// a durable operation + member rows, DB-authoritative bounded concurrency where claim_provision_slots is the
// ONLY concurrency authority (NO renderer semaphore, NO fixed sleeps), failed-member same-id retry, governed
// cancel, and an atomic group built ONLY after a DB reread shows EVERY member completed. Recovery/replay ride
// the v2 resume record (client INPUT blueprint + client-only source refs/fingerprints) from agentProvision.ts.

export interface TeamMemberProvisionInput {
  member: AgentProvisionMemberInput
  memoryContent?: AgentMemoryContentInput
  historyPayload?: AgentHistoryImportInput
  historySource?: { filePath: string; source: string; sessionId?: string }
}

export interface TeamProvisionInput {
  groupChatId: string
  teamName: string
  groupPrompt: string
  concurrencyLimit?: number
  members: TeamMemberProvisionInput[]
}

export interface TeamProvisionDeps extends ProvisionRuntimeDeps {
  resumeStore?: ProvisionResumeStore
  newId?: () => string
  getOwnerUserId?: () => Promise<string>
  ensureDeviceOnline?: (deviceId: string) => Promise<void>
  computeSourceDigest?: (payload: unknown) => Promise<string>
  readMemory?: (memberKey: string, sources: AgentMemorySource[]) => Promise<AgentMemoryContentInput | null>
  readHistory?: (memberKey: string, ref: AgentProvisionHistorySourceRef) => Promise<AgentHistoryImportInput | null>
  // explicit retry of failed members (partial-failure recovery); default false — a fresh run SURFACES failures.
  retryFailedMembers?: boolean
  /**
   * Announces the durable operation id at the PRE-RPC fence, so a caller can persist its own owner-scoped
   * side intent (e.g. the preset team's starter → [[starterContinuation]]) under the SAME id before any RPC.
   * The saga mints the id internally, so without this seam that intent could only be saved AFTER success —
   * i.e. exactly not in the crash window it exists for. AWAITED, so the side intent is durable before the first
   * RPC; throwing (or rejecting) here aborts the create (fail loud) — never fire-and-forget.
   */
  onOperationCreated?: (operationId: string) => void | Promise<void>
  /** Announced only after startProvisionOperation returned a durable row; safe point for an explicit cancel handle. */
  onOperationStarted?: (operationId: string) => void | Promise<void>
}

export interface TeamProvisionResult {
  operationId: string
  operation: AgentProvisionOperation
  members: AgentProvision[]
  outcomes: AgentProvisionMemberOutcome[]
  group?: { id: string } & Record<string, unknown>
  allCompleted: boolean
}

export class TeamCancellationRecoveryRequiredError extends Error {
  readonly operationId: string

  constructor(operationId: string, teamName?: string) {
    const subject = teamName ? `team ${teamName} operation ${operationId}` : `operation ${operationId}`
    super(`${subject} remains in cleaning_up; cancellation work is still in progress`)
    this.name = 'TeamCancellationRecoveryRequiredError'
    this.operationId = operationId
  }
}

interface TeamRuntime {
  memoryContentMap?: Record<string, AgentMemoryContentInput>
  historyByMember: Record<string, AgentHistoryImportInput | undefined>
}

const teamReadMemoryUnset = async (): Promise<AgentMemoryContentInput | null> => {
  throw new Error('resumeTeam requires a readMemory provider (inject deps.readMemory)')
}
const teamReadHistoryUnset = async (): Promise<AgentHistoryImportInput | null> => {
  throw new Error('resumeTeam requires a readHistory provider (inject deps.readHistory)')
}

async function assertBoundDeviceAvailable(deviceId: string, deps: TeamProvisionDeps): Promise<void> {
  try {
    await (deps.ensureDeviceOnline ?? defaultEnsureDeviceOnline)(deviceId)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `team provision operation is bound to device ${deviceId}, but that device is missing or stale (${reason}); recreate the team or cancel the operation`,
    )
  }
}

export async function provisionTeam(
  deviceId: string,
  input: TeamProvisionInput,
  deps: TeamProvisionDeps = {},
): Promise<TeamProvisionResult> {
  await (deps.ensureDeviceOnline ?? defaultEnsureDeviceOnline)(deviceId)
  const newId = deps.newId ?? newProvisionId
  const store = deps.resumeStore ?? defaultResumeStore
  const digest = deps.computeSourceDigest ?? clientSourceDigest
  const ownerUserId = await (deps.getOwnerUserId ?? getCurrentAuthUserId)()
  const operationId = newId()

  // Mint a stable provision id per member + build the client INPUT team blueprint (NO server-derived hash).
  const withIds = input.members.map((m) => ({ ...m, provisionId: newId() }))
  const blueprint = buildTeamBlueprint({
    groupChatId: input.groupChatId,
    teamName: input.teamName,
    groupPrompt: input.groupPrompt,
    concurrencyLimit: input.concurrencyLimit,
    members: withIds.map((m) => ({ ...m.member, provisionId: m.provisionId })),
  })

  const memoryContentMap: Record<string, AgentMemoryContentInput> = {}
  const historyByMember: Record<string, AgentHistoryImportInput | undefined> = {}
  const memberRefs: ProvisionResumeMemberRef[] = []
  for (const m of withIds) {
    const memberKey = m.member.memberKey
    const ref: ProvisionResumeMemberRef = { provisionId: m.provisionId, memberKey }
    // Divergence fails loud (P1.5): memoryContent without a matching memory_sources set is inconsistent intent —
    // surface it, do NOT silently drop it client-side (the DB's exact validation must be able to reject).
    if (m.memoryContent && !(m.member.memorySources && m.member.memorySources.length > 0)) {
      throw new Error(`provisionTeam: member ${memberKey} supplied memoryContent without memory_sources (divergent memory input)`)
    }
    const hasMemory = !!(m.member.memorySources && m.member.memorySources.length > 0 && m.memoryContent)
    if (hasMemory) {
      memoryContentMap[memberKey] = m.memoryContent as AgentMemoryContentInput
      ref.memorySourceRef = { sources: m.member.memorySources as AgentMemorySource[], clientDigest: await digest(m.memoryContent) }
    }
    if (m.member.historyImportRequired) {
      if (!m.historySource || !m.historyPayload) {
        throw new Error(`team member ${memberKey} declares history_import_required but has no historySource/historyPayload`)
      }
      historyByMember[memberKey] = m.historyPayload
      ref.historySourceRef = { ...m.historySource, clientDigest: await digest(m.historyPayload) }
    }
    memberRefs.push(ref)
  }

  // Announce the id BEFORE persisting our own record: if the caller's side-intent write fails, nothing durable
  // has been written yet and the create aborts clean. (Reversed, a failed side write would leave a resume record
  // for an operation that never started — the strictly worse residue.)
  await deps.onOperationCreated?.(operationId)
  // Persist the COMPLETE owner-scoped multi-member intent BEFORE the first RPC (fail-loud on write failure).
  const record: ProvisionResumeRecord = { version: 2, ownerUserId, operationId, deviceId, blueprint, members: memberRefs }
  store.remember(record)
  return driveTeam(record, deps, {
    memoryContentMap: Object.keys(memoryContentMap).length > 0 ? memoryContentMap : undefined,
    historyByMember,
  })
}

// Consume a durable team resume record: rehydrate every member's local sources from the record's client-only
// refs (fingerprint-verified; skip history whose DB root already landed), then replay start with the SAME
// ids + blueprint (idempotent) and drive.
export async function resumeTeam(record: ProvisionResumeRecord, deps: TeamProvisionDeps = {}): Promise<TeamProvisionResult> {
  // owner-scoped recovery boundary FIRST — before ANY local source read or RPC (P1.3/F3a); team entrypoint.
  await assertResumeRecordOwner(record, deps.getOwnerUserId ?? getCurrentAuthUserId, 'team')
  // Cancellation recovery has priority over device liveness: a cleaning_up operation must surface its explicit
  // cancel-only handle even when the device that originally ran it has since disappeared.
  const currentOperation = await getProvisionOperation(record.operationId)
  if (currentOperation?.phase === 'cleaning_up') {
    throw new TeamCancellationRecoveryRequiredError(
      record.operationId,
      record.blueprint.kind === 'team' ? record.blueprint.team_name : undefined,
    )
  }
  // A durable operation must never keep waiting on a device row that was removed or went stale after install/reinstall.
  // Check the binding before reading any owner-local source so the recovery error is immediate and actionable.
  await assertBoundDeviceAvailable(record.deviceId, deps)
  const digest = deps.computeSourceDigest ?? clientSourceDigest
  const memoryContentMap: Record<string, AgentMemoryContentInput> = {}
  const historyByMember: Record<string, AgentHistoryImportInput | undefined> = {}
  const existing = await listOperationMembers(record.operationId)
  const byKey = new Map(existing.map((m) => [m.member_key, m]))
  for (const ref of record.members) {
    if (ref.memorySourceRef) {
      const content = await (deps.readMemory ?? teamReadMemoryUnset)(ref.memberKey, ref.memorySourceRef.sources)
      if (!content) throw new Error(`resume: memory source for member ${ref.memberKey} is missing`)
      if ((await digest(content)) !== ref.memorySourceRef.clientDigest) {
        throw new Error(`resume: memory source for member ${ref.memberKey} changed (fingerprint mismatch)`)
      }
      memoryContentMap[ref.memberKey] = content
    }
    if (ref.historySourceRef && !byKey.get(ref.memberKey)?.history_thread_root_id) {
      const payload = await (deps.readHistory ?? teamReadHistoryUnset)(ref.memberKey, ref.historySourceRef)
      if (!payload) throw new Error(`resume: history source for member ${ref.memberKey} is missing`)
      if ((await digest(payload)) !== ref.historySourceRef.clientDigest) {
        throw new Error(`resume: history source for member ${ref.memberKey} changed (fingerprint mismatch)`)
      }
      historyByMember[ref.memberKey] = payload
    }
  }
  return driveTeam(record, deps, {
    memoryContentMap: Object.keys(memoryContentMap).length > 0 ? memoryContentMap : undefined,
    historyByMember,
  })
}

// Governed cancel — phase-based operation/member cancel + compare-and-delete of pending create commands. The
// Explicit cancellation removes created identities so the backend can settle the operation.
export interface CancelTeamProvisionResult {
  operation: AgentProvisionOperation
  /** true only when the DB advanced EVERY member (and the operation) to `cancelled`. */
  fullyCancelled: boolean
  /**
   * Per-member compensation failures — recorded, NEVER swallowed, and never aborting the remaining members.
   * `stage` attributes the failure: 'stop' = the courtesy runtime stop, 'remove' = the #2219 governed reclaim.
   * A 'stop' entry does NOT by itself mean the member failed to converge — settle's DB postconditions decide that
   * (`fullyCancelled`). It exists so a failed stop stays diagnosable instead of vanishing.
   */
  cleanupErrors: { provisionId: string; agentUserId: string; stage: 'stop' | 'remove'; error: string }[]
}

export interface CancelTeamProvisionDeps {
  resumeStore?: ProvisionResumeStore
  getOwnerUserId?: () => Promise<string>
  stopAgentRuntime?: (agentUserId: string) => Promise<void>
  removeOwnedAgent?: (agentUserId: string) => Promise<void>
}

async function clearCancelledRecovery(
  operationId: string,
  deps: CancelTeamProvisionDeps,
): Promise<void> {
  await clearCancelledStarter(operationId, deps.getOwnerUserId ?? getCurrentAuthUserId)
  const ownerUserId = await (deps.getOwnerUserId ?? getCurrentAuthUserId)()
  ;(deps.resumeStore ?? defaultResumeStore).forget(ownerUserId, operationId)
}

// @@@2260 explicit cancel = the THREE-STEP governed compensation (team-provision spec). An ordinary drive NEVER
// auto-removes a member; only this path reclaims live resources.
//   ① cancel_agent_provision_operation — phase-based: every not-yet-cancelled member (INCLUDING completed ones,
//      or terminal cancel would be impossible) → `cancelling`, operation → `cleaning_up`, pending create commands
//      compare-and-deleted, raw memory scrubbed, exact agent snapshotted.
//   ② per member that reached identity creation: courtesy runtime stop, then permanent identity removal.
//      A member that never bound an agent (queued-only) is NEVER removed — there is nothing to reclaim and settle
//      terminals it directly. Per-member BEST-EFFORT: one member's failure is recorded and the rest still proceed,
//      so a partial cleanup stays visible (`fullyCancelled=false`) and replay-recoverable rather than aborting.
//   ③ settle_provision_cancellation — the DB decides who converges, from durable postconditions only.
export async function cancelTeamProvision(
  operationId: string,
  deps: CancelTeamProvisionDeps = {},
): Promise<CancelTeamProvisionResult> {
  const stopRuntime = deps.stopAgentRuntime ?? defaultStopAgentRuntime
  const removeOwnedAgent = deps.removeOwnedAgent ?? defaultRemoveOwnedAgent

  await cancelProvisionOperation(operationId)

  // The cancel RPC intentionally early-returns for terminal operations. Re-read its durable row before touching
  // members: a finalized team is NOT a partly-cancelled team and must retain its group, agents, and runtimes.
  const postCancel = await getProvisionOperation(operationId)
  if (!postCancel) throw new Error(`cancelTeamProvision: operation ${operationId} disappeared after cancel intent`)
  if (postCancel.phase === 'completed') {
    return { operation: postCancel, fullyCancelled: false, cleanupErrors: [] }
  }
  if (postCancel.phase === 'cancelled') {
    await clearCancelledRecovery(operationId, deps)
    return { operation: postCancel, fullyCancelled: true, cleanupErrors: [] }
  }
  if (postCancel.phase !== 'cleaning_up') {
    throw new Error(`cancelTeamProvision: cancel intent left operation ${operationId} in unexpected phase ${postCancel.phase}`)
  }

  const cleanupErrors: CancelTeamProvisionResult['cleanupErrors'] = []
  for (const member of await listOperationMembers(operationId)) {
    const agentUserId = member.provisioned_agent_user_id
    // never bound an agent → nothing to reclaim (settle terminals it directly)
    if (!agentUserId) continue
    // already reclaimed: removal nulled the live link while keeping the evidence. On replay this is how we avoid
    // a second stop/remove for a member that has already converged.
    if (member.agent_user_id == null) continue
    // Courtesy stop: NOT fatal — a failed stop must not abort this member's reclaim nor the remaining members —
    // but it IS recorded. Convergence is still decided by settle's DB postconditions (a genuinely leftover runtime
    // keeps the member in `cancelling` → fullyCancelled=false); the record exists so the failure stays diagnosable
    // rather than silently vanishing.
    try {
      await stopRuntime(agentUserId)
    } catch (err) {
      cleanupErrors.push({
        provisionId: member.id,
        agentUserId,
        stage: 'stop',
        error: err instanceof Error ? err.message : String(err),
      })
    }
    try {
      await removeOwnedAgent(agentUserId)
    } catch (err) {
      cleanupErrors.push({
        provisionId: member.id,
        agentUserId,
        stage: 'remove',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const operation = await settleProvisionCancellation(operationId)
  const fullyCancelled = operation.phase === 'cancelled'
  // A converged cancel must leave NOTHING rejoinable. Cancel owns this cleanup explicitly, so without it the
  // resume record would resurrect a CANCELLED operation and permanently block that team from being created again.
  // The starter pointer goes the same way (its operation is terminal, reason='cancelled').
  // NOT converged (`cleaning_up`) → keep BOTH: compensation must still be resumable, and the user's edited starter
  // must not be discarded mid-flight.
  if (fullyCancelled) {
    await clearCancelledRecovery(operationId, deps)
  }
  return { operation, fullyCancelled, cleanupErrors }
}

// Collect fulfilled member outcomes; a REJECTED runClaimedMember (a thrown prepare/import/complete RPC error or a
// missing-command anomaly — distinct from a durable 'failed' outcome, which resolves fulfilled) must FAIL LOUD,
// never be silently swallowed (else the member stalls occupying a slot and the driver returns allCompleted=false
// with no surfaced error). Durable member rows persist, so the operation stays resumable after this throw.
function collectOutcomesOrThrow(
  settled: PromiseSettledResult<AgentProvisionMemberOutcome>[],
  outcomes: AgentProvisionMemberOutcome[],
): void {
  for (const s of settled) if (s.status === 'fulfilled') outcomes.push(s.value)
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
  if (rejected.length > 0) {
    const reasons = rejected.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
    throw new Error(`teamProvisionSaga: ${rejected.length} member(s) threw during drive — ${reasons.join('; ')}`)
  }
}

interface SettledMemberRun {
  provisionId: string
  result: PromiseSettledResult<AgentProvisionMemberOutcome>
}

type ActiveMemberRuns = Map<string, Promise<SettledMemberRun>>

function startMemberRuns(
  rows: AgentProvision[],
  active: ActiveMemberRuns,
  deps: TeamProvisionDeps,
  runtime: TeamRuntime,
): void {
  for (const row of rows) {
    if (active.has(row.id)) throw new Error(`teamProvisionSaga: member ${row.id} was scheduled twice in one drive`)
    active.set(row.id, runClaimedMember(row, deps, runtime.historyByMember[row.member_key]).then(
      (value): SettledMemberRun => ({ provisionId: row.id, result: { status: 'fulfilled', value } }),
      (reason): SettledMemberRun => ({ provisionId: row.id, result: { status: 'rejected', reason } }),
    ))
  }
}

async function settleNextMemberRun(
  active: ActiveMemberRuns,
  outcomes: AgentProvisionMemberOutcome[],
): Promise<void> {
  const first = await Promise.race(active.values())
  active.delete(first.provisionId)
  if (first.result.status === 'rejected') {
    // Preserve the old fail-loud boundary without abandoning work already admitted by the DB. Wait for those
    // members to settle, then report every rejection together; no detached member promise survives the drive.
    const remaining = await Promise.all(active.values())
    active.clear()
    collectOutcomesOrThrow([first.result, ...remaining.map((entry) => entry.result)], outcomes)
    return
  }
  collectOutcomesOrThrow([first.result], outcomes)
}

async function driveTeam(
  record: ProvisionResumeRecord,
  deps: TeamProvisionDeps,
  runtime: TeamRuntime,
): Promise<TeamProvisionResult> {
  // start is idempotent on the same id + blueprint (replay/resume → the EXISTING operation, never a second one).
  const operation = await startProvisionOperation(record.operationId, record.deviceId, record.blueprint, runtime.memoryContentMap)
  if (operation.phase === 'cleaning_up') {
    throw new TeamCancellationRecoveryRequiredError(
      record.operationId,
      record.blueprint.kind === 'team' ? record.blueprint.team_name : undefined,
    )
  }
  // Re-check after the idempotent operation read and before claim/prepare work: the device may disappear after a
  // fresh preflight or while a resume record is being rehydrated. Cancellation recovery wins over this check so
  // cleaning_up remains an explicit cancel-only path.
  await assertBoundDeviceAvailable(record.deviceId, deps)
  // Unlike onOperationCreated (the pre-RPC side-intent fence), this hook runs only after the operation row exists.
  // UI may expose explicit cancel only from this point; publishing the id earlier creates a missing-operation race.
  await deps.onOperationStarted?.(record.operationId)
  const outcomes: AgentProvisionMemberOutcome[] = []
  const retried = new Set<string>()
  const driven = new Set<string>()   // F1: crashed in-flight members re-driven at most once per drive (no spin)
  const active: ActiveMemberRuns = new Map()

  // Bounded-concurrency drive: claim_provision_slots is the ONLY authority — under the operation-row lock it
  // returns at most (limit - inflight) queued members. Loop until nothing is claimable, no crashed in-flight
  // member remains to re-drive, and no retry work remains. NO renderer semaphore, NO fixed sleeps; convergence
  // is driven by real command terminals.
  // #2260 round-6 (P1-1): BEFORE any capacity RPC or direct run, snapshot every member and run the cancel-only
  // precheck on ALL of them. A stable governed-removed member (evidence retained, live link nulled) can only
  // converge through cancel/settle, so the WHOLE drive fails loud here rather than letting the DB reject a claim we
  // should never have issued. Re-checked each iteration below for members we are about to drive; the DB stays the
  // race fence for a removal that commits mid-flight.
  for (const m of await listOperationMembers(record.operationId)) assertMemberNotCancelOnly(m)

  for (;;) {
    const claimed = await claimProvisionSlots(record.operationId)
    if (claimed.length > 0) {
      claimed.forEach((row) => driven.add(row.id))
      startMemberRuns(claimed, active, deps, runtime)
      // A claim may return the full budget, but replacement work becomes eligible as soon as ANY member reaches
      // a durable terminal. Waiting for the whole batch would leave a released DB slot idle behind its slow peer.
      await settleNextMemberRun(active, outcomes)
      continue
    }
    const snapshot = await listOperationMembers(record.operationId)
    // F1 recovery: re-drive EVERY durable NON-TERMINAL member claim will never re-emit — a crash / slow-handshake
    // timeout can strand members in preparing / awaiting_terminal / ready, but claim_provision_slots only moves
    // 'queued'. runClaimedMember is idempotent (prepare replay → wait TRUE terminal → settle → [history] →
    // complete); each is driven at most ONCE per drive (guarded by `driven`), so a still-nonterminal member cannot
    // spin — it just stays resumable. Without this a crashed team stalls forever (claim empty, only failed retried).
    const inflight = snapshot.filter(
      (m) => (m.phase === 'preparing' || m.phase === 'awaiting_terminal' || m.phase === 'ready') && !driven.has(m.id) && !retried.has(m.id),
    )
    if (inflight.length > 0) {
      inflight.forEach((m) => assertMemberNotCancelOnly(m))   // round-6: precheck before runClaimedMember
      inflight.forEach((m) => driven.add(m.id))
      startMemberRuns(inflight, active, deps, runtime)
      await settleNextMemberRun(active, outcomes)
      continue
    }
    // Explicit failed-member retry. It MUST go through the claim capacity authority (retry-selection):
    // claim_provision_slots promotes the selected failed → preparing under the operation-row lock + concurrency
    // budget (prepare rejects a direct 'failed'), then we drive the GRANTED rows.
    // round-6 (P1-5): record as attempted ONLY the members the DB actually granted. Marking every requested id
    // would strand the over-budget remainder for the rest of this drive (limit 2 with 3 failed members left the
    // third unretried and allCompleted=false), so an ungranted failed member stays eligible for the next loop
    // iteration once capacity frees, while a granted member is still driven at most once per drive (no spin).
    const failedIds = deps.retryFailedMembers ? snapshot.filter((m) => m.phase === 'failed' && !retried.has(m.id)).map((m) => m.id) : []
    if (failedIds.length > 0) {
      const reclaimed = await claimProvisionSlots(record.operationId, undefined, failedIds)
      if (reclaimed.length > 0) {
        reclaimed.forEach((row) => { retried.add(row.id); driven.add(row.id) })
        startMemberRuns(reclaimed, active, deps, runtime)
        await settleNextMemberRun(active, outcomes)
        continue
      }
    }
    // A still-running peer is awaited only after queued first-claims, crash recovery, and explicit retries have
    // all had a chance to consume any slot released by an earlier terminal. If a retry had no current budget,
    // one active terminal changes that fact and the next iteration rechecks the DB instead of breaking early.
    if (active.size > 0) {
      await settleNextMemberRun(active, outcomes)
      continue
    }
    break
  }

  // Finalize ONLY after a DB reread shows EVERY member completed (never on all-ready). finalize is idempotent
  // (an existing group is returned from the stored operation result), so retry/replay never builds a 2nd group.
  const members = await listOperationMembers(record.operationId)
  const allCompleted = members.length > 0 && members.every((m) => m.phase === 'completed')
  let group: ({ id: string } & Record<string, unknown>) | undefined
  if (allCompleted) {
    group = await finalizeAgentTeam(record.operationId)
  }
  const finalOp = (await getProvisionOperation(record.operationId)) ?? operation
  // DB completion is not the renderer's success handoff. Keep the owner-scoped record until the unique handoff
  // owner lands the draft and navigates to the finalized group; otherwise a crash in that gap can fork a new team.
  return { operationId: record.operationId, operation: finalOp, members, outcomes, group, allCompleted }
}
