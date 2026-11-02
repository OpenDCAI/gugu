import { ASSISTANT_CHILD_HARNESS, ASSISTANT_FIRST_TASK } from '@gugu/core/shared/assistantPolicy'
import type { CreateAgentOnDeviceResult } from '@gugu/core/shared/types/chat'
import { machineRpc } from '../mobile/agent-watch/sessionpage-rpc'
import { desktopIpc } from '../platform/desktopIpc'
import { assistantResumeStore, cleanAssistantSetupDraft, completedAssistantSetup, type AssistantSetupDraft } from './assistantSetup'
import { provisionSingleAgent, resumeSingleAgent, type ProvisionResumeRecord } from './agentProvision'
import { fetchAgentHarnessModels } from './agentModelSelection'
import { getCurrentAuthUserId } from './supabase'
import { listDevicesOnceIdentified } from './listDevicesOnceIdentified'
import { assistantServerTargets } from './assistantServerTargets'
import {
  AssistantServerSetupError, assistantServerFailure,
  type AssistantServerFailure, type AssistantServerOperation, type AssistantServerReply,
  type AssistantServerSetupProgress, type AssistantServerPreparation,
} from './assistantServerSetupTypes'

export { AssistantServerSetupError } from './assistantServerSetupTypes'
export type { AssistantServerFailure, AssistantServerSetupProgress } from './assistantServerSetupTypes'
export type { AssistantServerTarget, AssistantServerTargetReason } from './assistantServerTargets'
export type AssistantServerSetupRecord = {
  version: 1
  ownerUserId: string
  deviceId: string
  deviceLabel: string
  operationId: string
  draft: AssistantSetupDraft
  installationStarted: boolean
  model: string | null
  provisionOperationId?: string
}
export type AssistantServerSetupOptions = {
  signal?: AbortSignal
  onInstalling?: () => void
  onProgress?: (state: AssistantServerSetupProgress) => void
}
const key = (owner: string) => `gugu.assistant.server-setup:${owner}`
const fail = (code: AssistantServerFailure['code'], cause?: unknown): never => { throw new AssistantServerSetupError(assistantServerFailure(code), { cause }) }
const aborted = () => Object.assign(new Error('Assistant setup cancelled'), { name: 'AbortError' })
const unwrap = <T>(reply: AssistantServerReply<T>): T => {
  if (!reply.ok) throw new AssistantServerSetupError(reply.error)
  return reply.value
}
function save(record: AssistantServerSetupRecord) { window.localStorage.setItem(key(record.ownerUserId), JSON.stringify(record)) }
function forget(record: AssistantServerSetupRecord) { window.localStorage.removeItem(key(record.ownerUserId)) }
export function pendingServerAssistant(ownerUserId: string): AssistantServerSetupRecord | null {
  const raw = window.localStorage.getItem(key(ownerUserId))
  if (!raw) return null
  let value: AssistantServerSetupRecord
  try { value = JSON.parse(raw) as AssistantServerSetupRecord } catch (cause) { return fail('input_mismatch', cause) }
  if (value.version !== 1 || value.ownerUserId !== ownerUserId || !value.deviceId || !value.operationId || !value.draft || typeof value.installationStarted !== 'boolean') return fail('input_mismatch')
  return value
}
export async function listAssistantServerTargets() { return assistantServerTargets(await listDevicesOnceIdentified()) }
async function targetAvailable(id: string) {
  const target = (await listAssistantServerTargets()).find(row => row.deviceId === id)
  if (!target) return fail('target_not_owned')
  if (target.reason) return fail(target.reason)
  return target
}
async function owner(record: AssistantServerSetupRecord) {
  if (!desktopIpc()) return fail('unsupported_platform')
  if (await getCurrentAuthUserId() !== record.ownerUserId) return fail('account_changed')
  await targetAvailable(record.deviceId)
}
const binding = (record: AssistantServerSetupRecord): AssistantServerOperation => ({ ownerUserId: record.ownerUserId, deviceId: record.deviceId, operationId: record.operationId })
let inFlight: Promise<CreateAgentOnDeviceResult> | null = null
function singleFlight(run: () => Promise<CreateAgentOnDeviceResult>) {
  if (inFlight) return inFlight
  const promise = run()
  inFlight = promise
  const clear = () => { if (inFlight === promise) inFlight = null }
  void promise.then(clear, clear)
  return promise
}

export function setUpAssistantOnServer(draft: AssistantSetupDraft, deviceId: string, options: AssistantServerSetupOptions = {}) {
  return singleFlight(async () => {
    if (!desktopIpc()) return fail('unsupported_platform')
    if (options.signal?.aborted) throw aborted()
    cleanAssistantSetupDraft(draft)
    const ownerUserId = await getCurrentAuthUserId()
    if (pendingServerAssistant(ownerUserId) || assistantResumeStore.list(ownerUserId).length) return fail('preparation_busy')
    const target = await targetAvailable(deviceId)
    const record: AssistantServerSetupRecord = { version: 1, ownerUserId, deviceId, deviceLabel: target.label, operationId: crypto.randomUUID(), draft, installationStarted: false, model: null }
    // Save the original target and draft before the first target mutation.
    save(record)
    return drive(record, options)
  })
}

export function resumeServerAssistant(options: AssistantServerSetupOptions = {}) {
  return singleFlight(async () => {
    const record = pendingServerAssistant(await getCurrentAuthUserId())
    if (!record) return fail('preparation_not_found')
    return drive(record, options)
  })
}

async function prepare(record: AssistantServerSetupRecord, options: AssistantServerSetupOptions): Promise<AssistantServerPreparation> {
  const api = machineRpc(record.deviceId).assistantHome
  const args = binding(record)
  const installing = () => {
    if (!record.installationStarted) { record.installationStarted = true; save(record) }
    options.onInstalling?.()
  }
  if (record.installationStarted) options.onInstalling?.()
  let state = unwrap(await api.start({ ...args, ownerProfile: cleanAssistantSetupDraft(record.draft).ownerProfile }))
  for (;;) {
    if (state.installationStarted) installing()
    if (state.phase !== 'prepared') options.onProgress?.({ phase: state.phase, cancellable: state.cancellable, ...(state.error ? { error: state.error } : {}) })
    if (options.signal?.aborted && state.cancellable) {
      const cancelled = unwrap(await api.cancel(args))
      if (cancelled.cancelled) { forget(record); throw aborted() }
      state = cancelled.state
      if (state.installationStarted) installing()
    }
    if (state.phase === 'cancelled') { forget(record); throw aborted() }
    if (state.phase === 'failed') throw new AssistantServerSetupError(state.error ?? assistantServerFailure('runtime_failed'))
    if (state.phase === 'prepared') return state
    await new Promise(resolve => setTimeout(resolve, 300))
    state = unwrap(await api.status(args))
  }
}

async function drive(record: AssistantServerSetupRecord, options: AssistantServerSetupOptions): Promise<CreateAgentOnDeviceResult> {
  try {
    await owner(record)
    const pending = assistantResumeStore.list(record.ownerUserId).find(item =>
      item.operationId === record.provisionOperationId || (!record.provisionOperationId && item.deviceId === record.deviceId))
    if (pending) {
      if (pending.deviceId !== record.deviceId) return fail('input_mismatch')
      if (!record.provisionOperationId) { record.provisionOperationId = pending.operationId; save(record) }
      options.onInstalling?.()
      options.onProgress?.({ phase: 'starting', cancellable: false })
      const result = await resumeServerAssistantProvision(pending)
      forget(record)
      options.onProgress?.({ phase: 'ready', cancellable: false })
      return result
    }
    options.onProgress?.({ phase: 'checking', cancellable: !record.installationStarted })
    const preflight = unwrap(await machineRpc(record.deviceId).assistantHome.preflight({ ownerUserId: record.ownerUserId, deviceId: record.deviceId }))
    const prepared = await prepare(record, options)
    if (!prepared.home) return fail('workspace_failed')
    await owner(record)
    // Both the model directory and credential check are executed on the target.
    const catalog = await fetchAgentHarnessModels(record.deviceId, 'claude', false)
    const model = preflight.modelSource === 'platform'
      ? catalog.models.find(item => item.id === preflight.defaultModel && item.source === 'gugu' && !item.requires_membership && !item.hidden)?.id
      : catalog.selectedCredential === 'credentialed' ? catalog.selected : null
    if (!model) return fail('model_unavailable')
    record.model = model
    save(record)
    const clean = cleanAssistantSetupDraft(record.draft)
    options.onProgress?.({ phase: 'creating', cancellable: false })
    let operationIdUsed = false
    const provision = await provisionSingleAgent(record.deviceId, {
      memberKey: 'assistant', displayName: clean.name, agentType: 'claude-code',
      projectPath: prepared.home.workdir, avatar: clean.avatar, inheritMemory: false, historyImportRequired: false,
    }, {
      resumeStore: assistantResumeStore, model,
      newId: () => { if (operationIdUsed) return crypto.randomUUID(); operationIdUsed = true; return record.operationId },
      assistant: { childHarness: ASSISTANT_CHILD_HARNESS, firstTask: ASSISTANT_FIRST_TASK },
      onAttemptRecorded: next => { record.provisionOperationId = next.operationId; save(record) },
    })
    const result = completedAssistantSetup(provision)
    forget(record)
    options.onProgress?.({ phase: 'ready', cancellable: false })
    return result
  } catch (cause) {
    if ((cause as Error)?.name === 'AbortError') throw cause
    const failure = cause instanceof AssistantServerSetupError ? { code: cause.code, retryable: cause.retryable, next: cause.next }
      : assistantServerFailure(record.provisionOperationId ? 'provision_failed' : 'target_unreachable')
    options.onProgress?.({ phase: 'failed', cancellable: !record.installationStarted, error: failure })
    throw cause instanceof AssistantServerSetupError ? cause : new AssistantServerSetupError(failure, { cause })
  }
}

/** Recovery from the shared assistant shell also respects the recorded target. */
export async function resumeServerAssistantProvision(record: ProvisionResumeRecord): Promise<CreateAgentOnDeviceResult> {
  if (await getCurrentAuthUserId() !== record.ownerUserId) return fail('account_changed')
  await targetAvailable(record.deviceId)
  const stored = pendingServerAssistant(record.ownerUserId)
  if (!stored || stored.deviceId !== record.deviceId || stored.provisionOperationId !== record.operationId) return fail('input_mismatch')
  if (!stored.model) return fail('model_unavailable')
  const result = completedAssistantSetup(await resumeSingleAgent(record, {
    resumeStore: assistantResumeStore, model: stored.model,
    assistant: { childHarness: ASSISTANT_CHILD_HARNESS, firstTask: ASSISTANT_FIRST_TASK },
  }))
  forget(stored)
  return result
}
