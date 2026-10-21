/**
 * createAgentTeam — 把一个 AgentTeam 真实创建出来:几个 agent + 一个群。
 *
 * 薄适配器,不是第二套编排:只做四件事 —— ① 把向导预览里的最终选择翻译成成员意图(member_key = tempId,
 * persona → special_focus,团队一律不继承记忆/不导入历史/listen_mode='active');② 挑一台在线本地设备;
 * ③ 把 onProgress 透传给向导;④ 整条创建交给 provisionTeam(DB-authoritative saga)。
 *
 * 关闭向导 ≠ 取消:同进程重进订阅同一 create promise；进程重启才从 durable record 接回同一 operation。
 * 两条路径都 ❌ 不并行建第二个团队，且只有一个 attachment 拥有成功 handoff。
 *
 * 并发/终态/恢复/取消/建群全归 saga:claim_provision_slots 是唯一容量权威(❌ renderer 信号量、❌ 固定 sleep),
 * 全员 completed 后 finalize_agent_team 原子建群并发布(owner+agents+章程+每成员 listen_mode)；成员 DM 从不发布。
 * 故此处 ❌ 不再有逐成员 createAgentOnDevice、❌ 手工 createGroupChat/archiveChat/setAgentListenMode。
 *
 * ❌ 不静默兜底:缺在线本地设备 / 云 agent 入群(#1761) / 任一成员未 completed / 建成后取不到群行,都报错停。
 */

import type { AgentTeam } from '../components/BuildAgentWizard'
import type { CleanupStage } from './cleanupStageCopy'
import { chatService } from './chat'
import {
  buildTeamBlueprint,
  defaultResumeStore,
  getProvisionOperation,
  newProvisionId,
  teamBlueprintIntentFingerprint,
  type ProvisionResumeRecord,
} from './agentProvision'
import {
  cancelTeamProvision,
  provisionTeam,
  resumeTeam,
  TeamCancellationRecoveryRequiredError,
  type TeamProvisionResult,
  type TeamMemberProvisionInput,
} from './teamProvisionSaga'
import { getCurrentAuthUserId } from './supabase'
import {
  rememberStarterForOperation,
  bindStarterGroup,
  clearCancelledStarter,
  clearLandedStarter,
  starterContinuationStore,
} from './starterContinuation'
import { normalizeAgentType } from '@gugu/core/agentTypes'
import { isCloudAgentMarked } from '@gugu/core/shared/enums/agentTypeModels'
import type { AgentProvisionOperationPhase } from '@gugu/core/shared/types/agentProvision'
import { i18n } from '@/i18n'

type TeamErrorKey =
  | 'cloudMemberUnsupported'
  | 'completedMemberMissingIdentity'
  | 'groupFinalizeMissing'
  | 'memberRequired'
  | 'membersIncomplete'
  | 'multiplePending'
  | 'noOnlineDevice'
  | 'onlyCloudDevices'
  | 'pendingConfigurationMismatch'
  | 'pendingConfigurationMismatchNoParallel'
  | 'pendingConfigurationMismatchShort'
  | 'unknownMember'

function teamError(key: TeamErrorKey, values: Record<string, unknown> = {}): string {
  switch (key) {
    case 'cloudMemberUnsupported': return i18n.t('wizard.errors.cloudMemberUnsupported', { ns: 'agents', ...values })
    case 'completedMemberMissingIdentity': return i18n.t('wizard.errors.completedMemberMissingIdentity', { ns: 'agents', ...values })
    case 'groupFinalizeMissing': return i18n.t('wizard.errors.groupFinalizeMissing', { ns: 'agents', ...values })
    case 'memberRequired': return i18n.t('wizard.errors.memberRequired', { ns: 'agents', ...values })
    case 'membersIncomplete': return i18n.t('wizard.errors.membersIncomplete', { ns: 'agents', ...values })
    case 'multiplePending': return i18n.t('wizard.errors.multiplePending', { ns: 'agents', ...values })
    case 'noOnlineDevice': return i18n.t('wizard.errors.noOnlineDevice', { ns: 'agents', ...values })
    case 'onlyCloudDevices': return i18n.t('wizard.errors.onlyCloudDevices', { ns: 'agents', ...values })
    case 'pendingConfigurationMismatch': return i18n.t('wizard.errors.pendingConfigurationMismatch', { ns: 'agents', ...values })
    case 'pendingConfigurationMismatchNoParallel': return i18n.t('wizard.errors.pendingConfigurationMismatchNoParallel', { ns: 'agents', ...values })
    case 'pendingConfigurationMismatchShort': return i18n.t('wizard.errors.pendingConfigurationMismatchShort', { ns: 'agents', ...values })
    case 'unknownMember': return i18n.t('wizard.errors.unknownMember', { ns: 'agents', ...values })
  }
}

export type CreateTeamProgressCode = 'resuming' | 'ready' | 'checking-device' | 'provisioning'

export interface CreateTeamProgress {
  ratio: number
  label: string
  code?: CreateTeamProgressCode
  provisioningCount?: number
  /** Opaque handle announced only after the durable start RPC succeeds; UI may then offer explicit cancel. */
  operationId?: string
}

export interface CreateTeamCancelResult {
  fullyCancelled: boolean
  /** The operation had already finalized; cancel was a true no-op and the success handoff must continue. */
  completedNoop: boolean
  /** 只进日志:每条都含下层抛的原文。❌ 不要拼进用户文案。 */
  cleanupErrors: string[]
  /** 给用户看的那一半:哪几步没做干净。我们自己的枚举,可本地化。 */
  cleanupStages: CleanupStage[]
}

export interface CreateTeamDeps {
  onProgress?: (p: CreateTeamProgress) => void
}

export interface CreateTeamResult {
  chatId: string
  agentIds: string[]
  /** durable operation id —— 上层据此在 starter 真落进草稿后清理续跑指针。 */
  operationId: string
  /** Exactly one attachment owns draft/navigation side effects for this in-process attempt. */
  handoffOwner?: boolean
  /** Latest durable starter intent, including an intentional empty string. */
  starterPrompt?: string
  /** Acknowledge or release the one-shot success handoff. */
  finishHandoff?: (succeeded: boolean) => void
  /** Fail if a later edit or real cancel invalidated this handoff lease. */
  assertHandoffCurrent?: () => void
  /** Wait through a temporary cancel fence, then run the side effect synchronously under this lease. */
  runWithHandoffCurrent?: (action: () => void) => Promise<void>
}

export interface CompleteTeamCreationHandoffDeps {
  setDraft: (chatId: string, value: string) => void
  close: () => void
  navigateToChat: (chatId: string) => void
  clearLandedStarter?: (operationId: string) => Promise<void>
}

/** The one production success continuation: draft -> durable-pointer settle -> close -> navigate. */
export async function completeAgentTeamCreationHandoff(
  team: AgentTeam,
  result: Pick<CreateTeamResult, 'chatId' | 'operationId' | 'finishHandoff' | 'assertHandoffCurrent' | 'runWithHandoffCurrent'>,
  deps: CompleteTeamCreationHandoffDeps,
): Promise<void> {
  const runCurrent = result.runWithHandoffCurrent ?? (async (action: () => void) => {
    result.assertHandoffCurrent?.()
    action()
  })
  try {
    const starter = team.starterPrompt
    if (starter !== undefined) {
      // The draft is verbatim user intent. A retry may write it again after pointer cleanup failed; setDraft is idempotent.
      await runCurrent(() => { deps.setDraft(result.chatId, starter) })
      await (deps.clearLandedStarter ?? clearLandedStarter)(result.operationId)
    }
    // A later edit can arrive while pointer cleanup awaits I/O. Re-check before the user-visible close/navigation,
    // then commit in the same synchronous segment so no newer attachment can interleave with these side effects.
    await runCurrent(() => {
      deps.close()
      deps.navigateToChat(result.chatId)
      result.finishHandoff?.(true)
    })
  } catch (error) {
    result.finishHandoff?.(false)
    throw error
  }
}

async function pickOnlineLocalDevice(): Promise<string> {
  const devices = await chatService.listDevices()
  const online = devices.filter((d) => d.is_online)
  if (online.length === 0) {
    throw new Error(teamError('noOnlineDevice'))
  }
  const local = online.find((d) => !d.device_id.startsWith('cloud:'))
  if (!local) {
    throw new Error(teamError('onlyCloudDevices'))
  }
  return local.device_id
}

/**
 * 已存 durable 记录是否就是「眼前这次预览的同一个团队意图」—— 按**精确语义指纹**判定
 * (teamBlueprintIntentFingerprint:忽略生成 id,精确比群字段与每成员完整语义元组,成员顺序无关)。
 *
 * ❌ 绝不「名字对上就算」:用户在重进的预览里换引擎 / 改 persona / 改群章程 / 加减成员,都是**另一个团队意图**;
 * 接回旧 operation 会拿旧意图冒充新意图,把用户的新配置静默丢掉 —— 那是本节点明令 fail loud 的分歧 payload。
 */
function sameTeamIntent(record: ProvisionResumeRecord, candidateFingerprint: string): boolean {
  const bp = record.blueprint
  if (bp.kind !== 'team') return false
  return teamBlueprintIntentFingerprint(bp) === candidateFingerprint
}

function hydrateTeamFromDurableRecord(team: AgentTeam, record: ProvisionResumeRecord): AgentTeam {
  const blueprint = record.blueprint
  if (blueprint.kind !== 'team') throw new Error(`operation ${record.operationId} is not a team provision record`)
  const unusedPresentation = [...team.members]
  const members = blueprint.members.map((stored, index) => {
    const sameName = unusedPresentation.filter((member) => member.displayName === stored.display_name)
    const presentation = sameName.length === 1 ? sameName[0] : team.members[index]
    if (presentation) {
      const used = unusedPresentation.indexOf(presentation)
      if (used >= 0) unusedPresentation.splice(used, 1)
    }
    return {
      tempId: stored.member_key,
      role: presentation?.role ?? stored.display_name,
      displayName: stored.display_name,
      description: presentation?.description ?? stored.special_focus ?? '',
      avatarUrl: stored.avatar ?? null,
      // @@@2470 模板 key 必须有值且不得由显示名派生；presentation 缺失时回落到稳定的 member_key。
      avatarSeed: presentation?.avatarSeed ?? stored.member_key,
      engineId: stored.agent_type,
      specialFocus: stored.special_focus,
    }
  })
  return {
    ...team,
    teamName: blueprint.team_name,
    groupPrompt: blueprint.group_prompt,
    members,
  }
}

interface TeamIntent {
  provisionMembers: TeamMemberProvisionInput[]
  fingerprint: string
}

interface DurableTeamRejoin {
  record: ProvisionResumeRecord
  /** null is the valid pre-start/pre-ack window before the DB row exists. */
  operationPhase: AgentProvisionOperationPhase | null
}

export interface AgentTeamReentryState {
  team: AgentTeam
  /** Present only while an earlier explicit cancel is still converging. */
  cancellationOperationId?: string
}

interface HandoffTicket {
  state: 'waiting' | 'granted' | 'settled'
  exposed: boolean
  stale: boolean
  promise: Promise<boolean>
  resolve: (handoffOwner: boolean) => void
  released: Promise<void>
  release: () => void
}

interface ActiveTeamAttempt {
  key: string
  ownerUserId: string
  teamName: string
  fingerprint: string
  starterPrompt: string | undefined
  durableStarterPrompt: string | undefined
  starterRevision: number
  starterPersistChain: Promise<void>
  operationId?: string
  completedGroupId?: string
  latestProgress?: CreateTeamProgress
  progressListeners: Set<(progress: CreateTeamProgress) => void>
  basePromise: Promise<CreateTeamResult>
  handoffClaimed: boolean
  handoffCommitted: boolean
  handoffOwnerTicket?: HandoffTicket
  handoffWaiters: HandoffTicket[]
  cancelRequested: boolean
  cancelDecision: Promise<void>
  resolveCancelDecision?: () => void
  cancelled: boolean
}

const activeTeamAttempts = new Map<string, ActiveTeamAttempt>()
const activeAttemptKey = (ownerUserId: string, teamName: string): string => `${ownerUserId}\u0000${teamName}`

export function resetAgentTeamCreationCoordinatorForTests(): void {
  for (const attempt of activeTeamAttempts.values()) {
    attempt.cancelled = true
    attempt.resolveCancelDecision?.()
    if (attempt.handoffOwnerTicket) settleHandoffTicket(attempt.handoffOwnerTicket, false)
    attempt.handoffOwnerTicket = undefined
    wakeAllHandoffWaiters(attempt)
  }
  activeTeamAttempts.clear()
}

function buildIntent(team: AgentTeam): TeamIntent {
  if (team.members.length === 0) throw new Error(teamError('memberRequired'))
  const provisionMembers: TeamMemberProvisionInput[] = team.members.map((m) => {
    const agentType = normalizeAgentType(m.engineId)
    if (isCloudAgentMarked({ agent_type: agentType })) {
      throw new Error(teamError('cloudMemberUnsupported', { member: m.displayName }))
    }
    return {
      member: {
        // tempId only identifies a preview member inside ONE operation. Re-entry uses the durable blueprint.
        memberKey: m.tempId,
        displayName: m.displayName,
        agentType,
        inheritMemory: false,
        historyImportRequired: false,
        listenMode: 'active',
        specialFocus: m.specialFocus?.trim() || m.description,
        avatar: m.avatarUrl ?? undefined,
      },
    }
  })
  const fingerprint = teamBlueprintIntentFingerprint(buildTeamBlueprint({
    groupChatId: 'fingerprint-placeholder',
    teamName: team.teamName,
    groupPrompt: team.groupPrompt ?? '',
    members: provisionMembers.map((m) => ({ ...m.member, provisionId: 'fingerprint-placeholder' })),
  }))
  return { provisionMembers, fingerprint }
}

async function findDurableRejoin(
  ownerUserId: string,
  teamName: string,
  fingerprint?: string,
): Promise<DurableTeamRejoin | undefined> {
  const liveRecords: DurableTeamRejoin[] = []
  const candidates = defaultResumeStore.list(ownerUserId).filter(
    (candidate) => candidate.blueprint.kind === 'team' && candidate.blueprint.team_name === teamName,
  )
  for (const candidate of candidates) {
    const operation = await getProvisionOperation(candidate.operationId)
    if (operation?.phase === 'cancelled') {
      defaultResumeStore.forget(ownerUserId, candidate.operationId)
      continue
    }
    liveRecords.push({ record: candidate, operationPhase: operation?.phase ?? null })
  }
  const ids = liveRecords.map(({ record }) => record.operationId).join('、')
  if (liveRecords.length > 1) {
    throw new Error(teamError('multiplePending', { teamName, count: liveRecords.length, operationIds: ids }))
  }
  if (fingerprint !== undefined && liveRecords.length === 1
    && liveRecords[0].operationPhase !== 'cleaning_up'
    && !sameTeamIntent(liveRecords[0].record, fingerprint)) {
    throw new Error(teamError('pendingConfigurationMismatch', { teamName, operationIds: ids }))
  }
  return liveRecords[0]
}

function broadcastProgress(attempt: ActiveTeamAttempt, progress: CreateTeamProgress): void {
  attempt.latestProgress = progress
  if (progress.operationId) attempt.operationId = progress.operationId
  for (const listener of attempt.progressListeners) listener(progress)
}

function reserveHandoffTicket(attempt: ActiveTeamAttempt): HandoffTicket {
  let resolve!: (handoffOwner: boolean) => void
  let release!: () => void
  const ticket: HandoffTicket = {
    state: 'waiting',
    exposed: false,
    stale: false,
    promise: new Promise<boolean>((done) => { resolve = done }),
    resolve: (handoffOwner) => { resolve(handoffOwner) },
    released: new Promise<void>((done) => { release = done }),
    release: () => { release() },
  }
  if (attempt.cancelled || attempt.handoffCommitted) {
    settleHandoffTicket(ticket, false)
    return ticket
  }
  if (!attempt.handoffClaimed) {
    attempt.handoffClaimed = true
    attempt.handoffOwnerTicket = ticket
    ticket.state = 'granted'
    ticket.resolve(true)
    return ticket
  }
  attempt.handoffWaiters.push(ticket)
  return ticket
}

function settleHandoffTicket(ticket: HandoffTicket, handoffOwner?: boolean): void {
  if (ticket.state === 'settled') return
  ticket.state = 'settled'
  if (handoffOwner !== undefined) ticket.resolve(handoffOwner)
  ticket.release()
}

function retryHandoff(attempt: ActiveTeamAttempt): void {
  const next = attempt.handoffWaiters.shift()
  if (next) {
    // Keep the claim reserved while handing the token directly to the FIFO head. A later attach cannot steal it.
    next.state = 'granted'
    attempt.handoffOwnerTicket = next
    next.resolve(true)
  } else {
    attempt.handoffClaimed = false
    attempt.handoffOwnerTicket = undefined
  }
}

function wakeAllHandoffWaiters(attempt: ActiveTeamAttempt): void {
  for (const ticket of attempt.handoffWaiters.splice(0)) {
    settleHandoffTicket(ticket, false)
  }
}

function abandonHandoffTicket(attempt: ActiveTeamAttempt, ticket: HandoffTicket): void {
  if (ticket.state === 'waiting') {
    const index = attempt.handoffWaiters.indexOf(ticket)
    if (index >= 0) attempt.handoffWaiters.splice(index, 1)
    settleHandoffTicket(ticket, false)
    return
  }
  if (ticket.state !== 'granted' || attempt.handoffOwnerTicket !== ticket) return
  settleHandoffTicket(ticket)
  attempt.handoffOwnerTicket = undefined
  if (!attempt.cancelled && !attempt.handoffCommitted) retryHandoff(attempt)
  else attempt.handoffClaimed = false
}

function finishHandoffTicket(
  attempt: ActiveTeamAttempt,
  ticket: HandoffTicket,
  succeeded: boolean,
  operationId?: string,
): void {
  if (ticket.state !== 'granted' || attempt.handoffOwnerTicket !== ticket) return
  const committed = succeeded && !ticket.stale && !attempt.cancelRequested && !attempt.cancelled
  if (committed) {
    if (!operationId) throw new Error('team success handoff cannot commit without its durable operation id')
    defaultResumeStore.forget(attempt.ownerUserId, operationId)
  }
  settleHandoffTicket(ticket)
  attempt.handoffOwnerTicket = undefined
  if (committed) {
    attempt.handoffCommitted = true
    attempt.handoffClaimed = false
    if (activeTeamAttempts.get(attempt.key) === attempt) activeTeamAttempts.delete(attempt.key)
    wakeAllHandoffWaiters(attempt)
  } else if (!attempt.cancelled) {
    retryHandoff(attempt)
  } else {
    attempt.handoffClaimed = false
    wakeAllHandoffWaiters(attempt)
  }
}

function assertHandoffTicketCurrent(attempt: ActiveTeamAttempt, ticket: HandoffTicket): void {
  if (
    ticket.state !== 'granted'
    || attempt.handoffOwnerTicket !== ticket
    || ticket.stale
    || attempt.cancelRequested
    || attempt.cancelled
    || attempt.handoffCommitted
  ) {
    throw new Error('team creation handoff is stale/superseded — refusing old draft/navigation side effects')
  }
}

async function runWithHandoffTicketCurrent(
  attempt: ActiveTeamAttempt,
  ticket: HandoffTicket,
  action: () => void,
): Promise<void> {
  if (attempt.cancelRequested) await attempt.cancelDecision
  assertHandoffTicketCurrent(attempt, ticket)
  action()
}

async function waitForExposedHandoffLease(attempt: ActiveTeamAttempt, requestedStarter: string): Promise<void> {
  const owner = attempt.handoffOwnerTicket
  if (!owner?.exposed || owner.state !== 'granted' || requestedStarter === attempt.starterPrompt) return
  owner.stale = true
  await owner.released
}

function beginCancelFence(attempt: ActiveTeamAttempt): void {
  if (attempt.cancelRequested || attempt.cancelled) return
  let resolve!: () => void
  attempt.cancelRequested = true
  attempt.cancelDecision = new Promise<void>((done) => { resolve = done })
  attempt.resolveCancelDecision = resolve
}

function finishCancelFence(attempt: ActiveTeamAttempt, cancelled: boolean): void {
  attempt.cancelled = cancelled
  attempt.cancelRequested = false
  attempt.resolveCancelDecision?.()
  attempt.resolveCancelDecision = undefined
}

async function assertStarterWriteAllowed(attempt: ActiveTeamAttempt): Promise<void> {
  if (attempt.cancelRequested) await attempt.cancelDecision
  if (attempt.cancelled) {
    throw new Error(`team creation ${attempt.operationId ?? attempt.key} was cancelled — refusing a late starter write`)
  }
}

async function currentAttemptOwner(attempt: ActiveTeamAttempt): Promise<string> {
  const owner = await getCurrentAuthUserId()
  await assertStarterWriteAllowed(attempt)
  if (!owner || owner !== attempt.ownerUserId) {
    throw new Error('team creation owner changed — refusing to write another owner\'s starter continuation')
  }
  return owner
}

function appendStarterAction(attempt: ActiveTeamAttempt, action: () => Promise<void>): Promise<void> {
  const write = attempt.starterPersistChain.then(action)
  // A failed action rejects its own attachment/drive, but does not poison a later edit already queued behind it.
  attempt.starterPersistChain = write.catch(() => undefined)
  return write
}

function persistStarterRevision(
  attempt: ActiveTeamAttempt,
  operationId: string,
  starter: string,
): Promise<void> {
  return appendStarterAction(attempt, async () => {
    await assertStarterWriteAllowed(attempt)
    await rememberStarterForOperation(operationId, starter, () => currentAttemptOwner(attempt))
    attempt.durableStarterPrompt = starter
    if (attempt.completedGroupId) {
      await bindStarterGroup(operationId, attempt.completedGroupId, () => currentAttemptOwner(attempt))
    }
  })
}

async function updateAttemptStarter(attempt: ActiveTeamAttempt, starter: string): Promise<void> {
  const revision = attempt.starterRevision + 1
  attempt.starterRevision = revision
  attempt.starterPrompt = starter
  if (!attempt.operationId) return
  try {
    await persistStarterRevision(attempt, attempt.operationId, starter)
  } catch (error) {
    // The optimistic predecessor may itself have failed. Roll back only to bytes known to have reached the store.
    if (attempt.starterRevision === revision) attempt.starterPrompt = attempt.durableStarterPrompt
    throw error
  }
}

async function bindCompletedGroup(attempt: ActiveTeamAttempt, operationId: string, groupChatId: string): Promise<void> {
  attempt.completedGroupId = groupChatId
  // Retain the group for a starter attached after completion, but do not make a starter-less team depend on auth
  // continuation I/O. A queued/known starter binds in this ordered action; a future first starter binds in its write.
  if (attempt.starterPrompt === undefined && attempt.durableStarterPrompt === undefined) return
  await appendStarterAction(attempt, async () => {
    await assertStarterWriteAllowed(attempt)
    await bindStarterGroup(operationId, groupChatId, () => currentAttemptOwner(attempt))
  })
}

async function waitForStarterPersistence(attempt: ActiveTeamAttempt): Promise<void> {
  // Writes can be appended while an earlier revision is in flight. Quiesce the chain before exposing handoff data.
  let pending: Promise<void>
  do {
    pending = attempt.starterPersistChain
    await pending
  } while (pending !== attempt.starterPersistChain)
}

/** 首建与接回共用的收尾:成员全 completed 校验 → 取 finalize 建成的群 → 绑指针 → 返回。 */
async function finishTeam(
  result: TeamProvisionResult,
): Promise<CreateTeamResult> {
  if (!result.allCompleted) {
    const failed = result.members.filter((m) => m.phase !== 'completed').map((m) => m.member_key)
    throw new Error(teamError('membersIncomplete', { members: failed.join(', ') || teamError('unknownMember') }))
  }
  const chatId = result.group?.id
  if (!chatId) throw new Error(teamError('groupFinalizeMissing'))
  const agentIds = result.members.map((m) => {
    if (!m.agent_user_id) throw new Error(teamError('completedMemberMissingIdentity', { member: m.member_key }))
    return m.agent_user_id
  })
  return { chatId, agentIds, operationId: result.operationId }
}

async function driveTeamAttempt(attempt: ActiveTeamAttempt, team: AgentTeam, intent: TeamIntent): Promise<CreateTeamResult> {
  const rejoin = await findDurableRejoin(attempt.ownerUserId, team.teamName, intent.fingerprint)
  if (rejoin) {
    const { record, operationPhase } = rejoin
    if (operationPhase === 'cleaning_up') {
      throw new TeamCancellationRecoveryRequiredError(record.operationId, team.teamName)
    }
    attempt.operationId = record.operationId
    const durablePointer = starterContinuationStore.find(attempt.ownerUserId, record.operationId)
    attempt.durableStarterPrompt = durablePointer?.starter
    if (attempt.starterPrompt === undefined) {
      attempt.starterPrompt = durablePointer?.starter
      if (attempt.starterPrompt !== undefined) attempt.starterRevision += 1
    }
    if (attempt.starterPrompt !== undefined) {
      await persistStarterRevision(attempt, record.operationId, attempt.starterPrompt)
    }
    broadcastProgress(attempt, { ratio: 0.1, label: '', code: 'resuming', operationId: record.operationId })
    const result = await resumeTeam(record, {
      ...(operationPhase === 'failed' ? { retryFailedMembers: true } : {}),
      onOperationStarted: (operationId) => {
        broadcastProgress(attempt, { ratio: 0.1, label: '', code: 'resuming', operationId })
      },
    })
    const finished = await finishTeam(result)
    await bindCompletedGroup(attempt, result.operationId, finished.chatId)
    broadcastProgress(attempt, { ratio: 1, label: '', code: 'ready', operationId: result.operationId })
    return finished
  }

  broadcastProgress(attempt, { ratio: 0.02, label: '', code: 'checking-device' })
  const deviceId = await pickOnlineLocalDevice()
  broadcastProgress(attempt, {
    ratio: 0.1,
    label: '',
    code: 'provisioning',
    provisioningCount: team.members.length,
  })
  const groupChatId = newProvisionId()
  const result = await provisionTeam(deviceId, {
    groupChatId,
    teamName: team.teamName,
    groupPrompt: team.groupPrompt ?? '',
    members: intent.provisionMembers,
  }, {
    onOperationCreated: async (operationId) => {
      attempt.operationId = operationId
      if (attempt.starterPrompt !== undefined) {
        await persistStarterRevision(attempt, operationId, attempt.starterPrompt)
      }
    },
    onOperationStarted: (operationId) => {
      broadcastProgress(attempt, {
        ratio: 0.1,
        label: '',
        code: 'provisioning',
        provisioningCount: team.members.length,
        operationId,
      })
    },
  })
  const finished = await finishTeam(result)
  await bindCompletedGroup(attempt, result.operationId, finished.chatId)
  broadcastProgress(attempt, { ratio: 1, label: '', code: 'ready', operationId: result.operationId })
  return finished
}

async function attachToAttempt(
  attempt: ActiveTeamAttempt,
  requestedStarter: string | undefined,
  onProgress?: (progress: CreateTeamProgress) => void,
): Promise<CreateTeamResult> {
  // Reserve by attach call order before starter persistence or any other await. Otherwise a later attach with no
  // starter write can overtake an earlier subscriber that is still durably recording the user's edited starter.
  const handoffTicket = reserveHandoffTicket(attempt)
  try {
    if (requestedStarter !== undefined) {
      await waitForExposedHandoffLease(attempt, requestedStarter)
      if (attempt.cancelRequested) await attempt.cancelDecision
      if (attempt.cancelled) throw new Error(`team creation ${attempt.operationId ?? attempt.key} was cancelled`)
      // Same bytes are an observer attach, not a revision. Rewriting after the owner clears the pointer would revive
      // terminal residue even though the handoff already committed successfully.
      if (requestedStarter !== attempt.starterPrompt) await updateAttemptStarter(attempt, requestedStarter)
    }
    if (onProgress) {
      attempt.progressListeners.add(onProgress)
      if (attempt.latestProgress) onProgress(attempt.latestProgress)
    }
    const result = await attempt.basePromise
    const reserved = await handoffTicket.promise
    await waitForStarterPersistence(attempt)
    const handoffOwner = reserved
      && !attempt.cancelled
      && !attempt.cancelRequested
      && !attempt.handoffCommitted
      && !handoffTicket.stale
      && handoffTicket.state === 'granted'
    if (reserved && !handoffOwner && handoffTicket.state === 'granted') {
      finishHandoffTicket(attempt, handoffTicket, false)
    }
    if (handoffOwner) handoffTicket.exposed = true
    let finished = false
    return {
      ...result,
      handoffOwner,
      starterPrompt: attempt.starterPrompt,
      finishHandoff: (succeeded) => {
        if (!handoffOwner || finished) return
        finished = true
        finishHandoffTicket(attempt, handoffTicket, succeeded, result.operationId)
      },
      assertHandoffCurrent: () => assertHandoffTicketCurrent(attempt, handoffTicket),
      runWithHandoffCurrent: (action) => runWithHandoffTicketCurrent(attempt, handoffTicket, action),
    }
  } catch (error) {
    abandonHandoffTicket(attempt, handoffTicket)
    throw error
  } finally {
    if (onProgress) attempt.progressListeners.delete(onProgress)
  }
}

/** Hydrate the wizard before rendering it, without starting or resuming a provision drive. */
export async function hydrateAgentTeamForReentry(team: AgentTeam): Promise<AgentTeamReentryState> {
  const ownerUserId = await getCurrentAuthUserId()
  const key = activeAttemptKey(ownerUserId, team.teamName)
  const active = activeTeamAttempts.get(key)
  if (active) {
    const intent = buildIntent(team)
    if (active.fingerprint !== intent.fingerprint) {
      throw new Error(teamError('pendingConfigurationMismatchShort', { teamName: team.teamName }))
    }
    return { team: { ...team, starterPrompt: active.starterPrompt } }
  }
  const rejoin = await findDurableRejoin(ownerUserId, team.teamName)
  if (!rejoin) return { team }
  // cleaning_up only exposes the explicit cancellation recovery handle. It does not resume creation, so keep the
  // caller's current presentation; durable intent projection is for a create/success handoff re-entry only.
  const durableTeam = rejoin.operationPhase === 'cleaning_up'
    ? team
    : hydrateTeamFromDurableRecord(team, rejoin.record)
  const pointer = starterContinuationStore.find(ownerUserId, rejoin.record.operationId)
  const hydratedTeam = pointer
    ? { ...durableTeam, starterPrompt: pointer.starter }
    : rejoin.operationPhase === 'completed'
      ? { ...durableTeam, starterPrompt: undefined }
      : durableTeam
  return rejoin.operationPhase === 'cleaning_up'
    ? { team: hydratedTeam, cancellationOperationId: rejoin.record.operationId }
    : { team: hydratedTeam }
}

/**
 * 真实创建一个 AgentTeam:saga 有界并发 provision 每个成员 → 全员 completed 后原子 finalize 建群。
 * 返回 finalize 实际建成的群 chatId,供上层跳转进聊天。
 */
export async function createAgentTeam(
  team: AgentTeam,
  deps: CreateTeamDeps
): Promise<CreateTeamResult> {
  const intent = buildIntent(team)
  const ownerUserId = await getCurrentAuthUserId()
  const key = activeAttemptKey(ownerUserId, team.teamName)
  const existing = activeTeamAttempts.get(key)
  if (existing) {
    if (existing.fingerprint !== intent.fingerprint) {
      throw new Error(teamError('pendingConfigurationMismatchNoParallel', { teamName: team.teamName }))
    }
    return attachToAttempt(existing, team.starterPrompt, deps.onProgress)
  }

  const attempt: ActiveTeamAttempt = {
    key,
    ownerUserId,
    teamName: team.teamName,
    fingerprint: intent.fingerprint,
    starterPrompt: team.starterPrompt,
    durableStarterPrompt: undefined,
    starterRevision: 0,
    starterPersistChain: Promise.resolve(),
    progressListeners: new Set(),
    basePromise: Promise.resolve(null as never),
    handoffClaimed: false,
    handoffCommitted: false,
    handoffWaiters: [],
    cancelRequested: false,
    cancelDecision: Promise.resolve(),
    cancelled: false,
  }
  activeTeamAttempts.set(key, attempt)
  attempt.basePromise = driveTeamAttempt(attempt, team, intent).catch((error: unknown) => {
    if (activeTeamAttempts.get(key) === attempt) activeTeamAttempts.delete(key)
    throw error
  })
  return attachToAttempt(attempt, team.starterPrompt, deps.onProgress)
}
/** Thin renderer adapter for the explicit cancel exit; UI receives only convergence and diagnostics. */
export async function cancelAgentTeamCreation(operationId: string): Promise<CreateTeamCancelResult> {
  const affected = [...activeTeamAttempts.entries()].filter(([, attempt]) => attempt.operationId === operationId)
  for (const [, attempt] of affected) beginCancelFence(attempt)
  let result: Awaited<ReturnType<typeof cancelTeamProvision>>
  try {
    result = await cancelTeamProvision(operationId)
  } catch (error) {
    for (const [, attempt] of affected) finishCancelFence(attempt, false)
    throw error
  }

  const completedNoop = result.operation.phase === 'completed'
  if (completedNoop) {
    for (const [, attempt] of affected) finishCancelFence(attempt, false)
  } else {
    // Any non-noop cancel owns the terminal outcome, including cleaning_up. Invalidate success tickets now, while
    // durable resume/starter records remain available until compensation actually converges.
    for (const [key, attempt] of affected) {
      finishCancelFence(attempt, true)
      if (attempt.handoffOwnerTicket) settleHandoffTicket(attempt.handoffOwnerTicket)
      attempt.handoffOwnerTicket = undefined
      attempt.handoffClaimed = false
      wakeAllHandoffWaiters(attempt)
      activeTeamAttempts.delete(key)
    }
    await Promise.all(affected.map(([, attempt]) => waitForStarterPersistence(attempt)))
    if (result.fullyCancelled) {
      // teamProvisionSaga also clears on convergence. This second terminal clear is intentionally after the
      // renderer write chain: it closes the crash/race window where a registered late write outlived that clear.
      await clearCancelledStarter(operationId)
    }
  }
  return {
    fullyCancelled: result.fullyCancelled,
    completedNoop,
    cleanupErrors: result.cleanupErrors.map((entry) => `${entry.stage}:${entry.provisionId}:${entry.error}`),
    cleanupStages: result.cleanupErrors.map((entry) => entry.stage),
  }
}
