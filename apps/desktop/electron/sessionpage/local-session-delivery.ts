import type { SessionpageDeliveryTarget } from './session-injection'
import { resolveSessionpageSessionIntegration } from '@gugu/session-plugins/agents'

export type LocalSessionMessage = {
  id: string
  text: string
  kind?: 'ordinary' | 'session-direct'
}

export type LocalSessionSender = (
  message: LocalSessionMessage,
) => Promise<{ status: 'not-ready' } | { status: 'accepted'; messageId: string }>

export type LocalSessionBinding = {
  sessionId: string
  providerId: string
  sendMessage: LocalSessionSender
  /** Resolves once this spawn's own native session has acknowledged itself. */
  waitUntilReady?: () => Promise<void>
  /** True while this spawn's agent is mid-turn, as the hook service reported it. */
  isTurnInFlight?: () => boolean
}

export type OfflineLocalSessionBinding = {
  sessionId: string
  providerId: string
}

export type LocalSessionInjectionAudit = {
  sessionId: string
  providerId: string
  messageId: string
  text: string
  acceptedAt: string
}

/**
 * Host-boundary contract for session-TUI local-session ownership: the host keeps the authoritative maps below and
 * hands the session-page bundle this bridge (`createLocalSessionDeliveryBridge`); the PTY side supplies the provider
 * callback that actually injects into its session. The host itself works on the maps directly.
 */
export interface LocalSessionDeliveryBridge {
  registerLive(agentUserId: string, binding: LocalSessionBinding): void
  registerOffline(agentUserId: string, binding: OfflineLocalSessionBinding): void
  replaceLiveWithOfflineForSession(sessionId: string): boolean
  unregisterSession(sessionId: string): void
  unregisterAgent(agentUserId: string, sessionId?: string): void
  liveSessionIdByAgent(agentUserId: string): string | null
  deliveryKeyForSession(sessionId: string): string | null
  waitUntilReady?(sessionId: string): Promise<void>
  isSessionTurnInFlight?(sessionId: string): boolean
  tryInjectSessionMessage(
    sessionId: string,
    message: LocalSessionMessage,
  ): Promise<boolean>
  recordDeliveryFailure?(entry: {
    sessionId: string
    providerId: string
    messageId: string
    text: string
    error: string
  }): void
  listOwners?(): Array<{
    agentUserId: string
    sessionId: string
    providerId: string
    state: 'live' | 'offline'
  }>
}

const bindingsByAgent = new Map<string, LocalSessionBinding>()
const agentsBySession = new Map<string, string>()
const offlineBindingsByAgent = new Map<string, OfflineLocalSessionBinding>()
const offlineAgentsBySession = new Map<string, string>()
const localSessionDeliveryFailures: Array<{
  sessionId: string
  providerId: string
  messageId: string
  text: string
  error: string
}> = []
// This receipt is kept in the host bundle. The session-page bundle has a separate module graph, so
// reading its PTY-side audit array from main would otherwise observe a different in-memory array.
const localSessionInjectionAudits: LocalSessionInjectionAudit[] = []

function removeLiveByAgent(agentUserId: string): void {
  const binding = bindingsByAgent.get(agentUserId)
  if (!binding) return
  bindingsByAgent.delete(agentUserId)
  if (agentsBySession.get(binding.sessionId) === agentUserId) {
    agentsBySession.delete(binding.sessionId)
  }
}

function removeOfflineByAgent(agentUserId: string): void {
  const binding = offlineBindingsByAgent.get(agentUserId)
  if (!binding) return
  offlineBindingsByAgent.delete(agentUserId)
  if (offlineAgentsBySession.get(binding.sessionId) === agentUserId) {
    offlineAgentsBySession.delete(binding.sessionId)
  }
}

function removeBySession(sessionId: string): void {
  const liveAgent = agentsBySession.get(sessionId)
  if (liveAgent) removeLiveByAgent(liveAgent)
  const offlineAgent = offlineAgentsBySession.get(sessionId)
  if (offlineAgent) removeOfflineByAgent(offlineAgent)
}

function assertIndexInvariants(): void {
  for (const [agentUserId, binding] of bindingsByAgent) {
    if (agentsBySession.get(binding.sessionId) !== agentUserId) {
      throw new Error(`local-session live owner index mismatch for ${agentUserId}`)
    }
  }
  for (const [sessionId, agentUserId] of agentsBySession) {
    if (bindingsByAgent.get(agentUserId)?.sessionId !== sessionId) {
      throw new Error(`local-session live session index mismatch for ${sessionId}`)
    }
  }
  for (const [agentUserId, binding] of offlineBindingsByAgent) {
    if (offlineAgentsBySession.get(binding.sessionId) !== agentUserId) {
      throw new Error(`local-session offline owner index mismatch for ${agentUserId}`)
    }
  }
  for (const [sessionId, agentUserId] of offlineAgentsBySession) {
    if (offlineBindingsByAgent.get(agentUserId)?.sessionId !== sessionId) {
      throw new Error(`local-session offline session index mismatch for ${sessionId}`)
    }
  }
}

function registerLiveInLocalMap(agentUserId: string, binding: LocalSessionBinding): void {
  removeBySession(binding.sessionId)
  removeLiveByAgent(agentUserId)
  removeOfflineByAgent(agentUserId)
  bindingsByAgent.set(agentUserId, binding)
  agentsBySession.set(binding.sessionId, agentUserId)
  assertIndexInvariants()
}

function registerOfflineInLocalMap(agentUserId: string, binding: OfflineLocalSessionBinding): void {
  removeBySession(binding.sessionId)
  removeLiveByAgent(agentUserId)
  removeOfflineByAgent(agentUserId)
  offlineBindingsByAgent.set(agentUserId, binding)
  offlineAgentsBySession.set(binding.sessionId, agentUserId)
  assertIndexInvariants()
}

type LocalSessionOwner = {
  agentUserId: string
  sessionId: string
  providerId: string
  state: 'live' | 'offline'
}

function internalListOwners(): LocalSessionOwner[] {
  return [
    ...[...bindingsByAgent.entries()].map(([agentUserId, binding]) => ({
      agentUserId,
      sessionId: binding.sessionId,
      providerId: binding.providerId,
      state: 'live' as const,
    })),
    ...[...offlineBindingsByAgent.entries()].map(([agentUserId, binding]) => ({
      agentUserId,
      sessionId: binding.sessionId,
      providerId: binding.providerId,
      state: 'offline' as const,
    })),
  ]
}

function internalReplaceLiveWithOffline(sessionId: string): boolean {
  const agentUserId = agentsBySession.get(sessionId)
  const binding = agentUserId ? bindingsByAgent.get(agentUserId) : undefined
  if (!agentUserId || !binding || binding.sessionId !== sessionId) return false
  registerOfflineInLocalMap(agentUserId, { sessionId, providerId: binding.providerId })
  return true
}

function internalUnregisterSession(sessionId: string): void {
  removeBySession(sessionId)
  assertIndexInvariants()
}

function internalUnregisterAgent(agentUserId: string, sessionId?: string): void {
  const live = bindingsByAgent.get(agentUserId)
  if (live && (!sessionId || live.sessionId === sessionId)) removeLiveByAgent(agentUserId)
  const offline = offlineBindingsByAgent.get(agentUserId)
  if (offline && (!sessionId || offline.sessionId === sessionId)) removeOfflineByAgent(agentUserId)
  assertIndexInvariants()
}

async function internalTryInjectSessionMessage(
  sessionId: string,
  message: LocalSessionMessage,
): Promise<boolean> {
  const agentUserId = agentsBySession.get(sessionId)
  const binding = agentUserId ? bindingsByAgent.get(agentUserId) : undefined
  if (!binding) return false
  try {
    const integration = resolveSessionpageSessionIntegration(binding.providerId, 'tui')
    if (integration.identity !== 'addressable' || integration.messageTransport !== 'local-session') {
      throw new Error(`session ${sessionId} does not declare a local-session message transport`)
    }
    const accepted = await binding.sendMessage(message)
    if (accepted.status !== 'accepted') return false
    recordLocalSessionInjectionAuditForTest({
      sessionId,
      providerId: binding.providerId,
      messageId: message.id,
      text: message.text,
      acceptedAt: new Date().toISOString(),
    })
    return true
  } catch (error) {
    recordLocalSessionDeliveryFailureForTest({
      sessionId,
      providerId: binding.providerId,
      messageId: message.id,
      text: message.text,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export function recordLocalSessionDeliveryFailureForTest(entry: {
  sessionId: string
  providerId: string
  messageId: string
  text: string
  error: string
}): void {
  if (process.env.GUGU_SESSION_TEST_HOOKS !== '1') return
  localSessionDeliveryFailures.push({ ...entry })
  if (localSessionDeliveryFailures.length > 100) localSessionDeliveryFailures.shift()
}

export function registerLocalSessionDelivery(
  agentUserId: string,
  binding: LocalSessionBinding,
): void {
  registerLiveInLocalMap(agentUserId, binding)
}

/**
 * Reserve the session-page delivery owner across a restart before its PTY is live. Messages addressed to this
 * owner remain in the durable local pending queue; they must never fall through to a gugu-native spawn.
 */
export function registerOfflineLocalSessionDelivery(
  agentUserId: string,
  binding: OfflineLocalSessionBinding,
): void {
  registerOfflineInLocalMap(agentUserId, binding)
}

/** Keep a recognized local-session owner mapped while its PTY is between generations. */
export function replaceLiveWithOfflineForSession(sessionId: string): boolean {
  return internalReplaceLiveWithOffline(sessionId)
}

export function unregisterLocalSessionDelivery(sessionId: string): void {
  internalUnregisterSession(sessionId)
}

/**
 * Remove a session-page local-session owner after its persistent identity has really been deleted.
 *
 * The optional conversation guard is deliberate: a stale reap can finish after the same agent identity has
 * already been provisioned for a replacement conversation. In that case the old reap must leave the new
 * live/offline binding intact rather than creating an owner-less delivery gap.
 */
export function unregisterLocalSessionDeliveryForAgent(
  agentUserId: string,
  sessionId?: string,
): void {
  internalUnregisterAgent(agentUserId, sessionId)
}

export function readLocalSessionDeliveryFailuresForTest() {
  if (process.env.GUGU_SESSION_TEST_HOOKS !== '1') {
    throw new Error('local-session delivery failure audit is disabled')
  }
  return localSessionDeliveryFailures.map((entry) => ({ ...entry }))
}

export function clearLocalSessionDeliveryFailuresForTest(): void {
  if (process.env.GUGU_SESSION_TEST_HOOKS !== '1') {
    throw new Error('local-session delivery failure audit is disabled')
  }
  localSessionDeliveryFailures.length = 0
}

/** Test-only host receipt for an accepted local-session injection. */
export function readLocalSessionInjectionAuditForTest(): LocalSessionInjectionAudit[] {
  if (process.env.GUGU_SESSION_TEST_HOOKS !== '1') {
    throw new Error('local-session injection audit is disabled')
  }
  return localSessionInjectionAudits.map((entry) => ({ ...entry }))
}

export function clearLocalSessionInjectionAuditForTest(): void {
  if (process.env.GUGU_SESSION_TEST_HOOKS !== '1') {
    throw new Error('local-session injection audit is disabled')
  }
  localSessionInjectionAudits.length = 0
}

function recordLocalSessionInjectionAuditForTest(entry: LocalSessionInjectionAudit): void {
  if (process.env.GUGU_SESSION_TEST_HOOKS !== '1') return
  localSessionInjectionAudits.push({ ...entry })
  if (localSessionInjectionAudits.length > 100) localSessionInjectionAudits.shift()
}

/** Snapshot of local-session ownership for host routing and built-run audits. */
export function listLocalSessionDeliveryOwners(): Array<{
  agentUserId: string
  sessionId: string
  providerId: string
  state: 'live' | 'offline'
}> {
  return internalListOwners()
}

export const localSessionDeliveryTarget: SessionpageDeliveryTarget = {
  deliveryTargetName: 'local-session-pty',
  waitUntilReady: waitForLocalSessionAdmission,
  isSessionTurnInFlight: isLocalSessionTurnInFlight,
  // Local-session is a legacy PTY-backed target; its transport capability remains unclassified so the
  // common inbox reader does not infer a busy-turn tier from the owner registry alone.
  liveSessionIdByAgent,
  deliveryKeyForSession,
  sessionProviderSurface(sessionId) {
    const owner = listLocalSessionDeliveryOwners().find(
      (candidate) => candidate.sessionId === sessionId && candidate.state === 'live',
    )
    return owner ? { providerId: owner.providerId, surface: 'tui' } : null
  },
  tryInjectSessionMessage: internalTryInjectSessionMessage,
}

/**
 * S2b 读者触发③(TUI 腿转 live):九家 local-session TUI 的注入点在 registerLive 那一刻可用,
 * push 世界靠 1s sweep 兜住的「转 live 即 drain」在 pull 世界由这个包装承担 —— 转 live 立刻踢一次
 * 收件箱 pull,否则打开面板后积压要等下一条新消息才到(用户感知为「消息丢了」且不 fail loud)。
 * 这是 local-session 腿的「session-live 产地」(spec delivery-routing #4896):kick 拿到 conversationId,
 * 宿主用同一个处理器既拉读者也排该会话的本机 outbox。
 */
export function withSessionLiveInboxKick(
  bridge: LocalSessionDeliveryBridge,
  kick: (agentUserId: string, sessionId: string) => void,
): LocalSessionDeliveryBridge {
  return {
    ...bridge,
    registerLive: (agentUserId, binding) => {
      bridge.registerLive(agentUserId, binding)
      kick(agentUserId, binding.sessionId)
    },
  }
}

/**
 * Adapter installed into the session-page bundle by the host. All methods are synchronous except the actual
 * provider callback, which is already carried by `LocalSessionBinding.sendMessage`.
 */
export function createLocalSessionDeliveryBridge(): LocalSessionDeliveryBridge {
  return {
    registerLive: registerLiveInLocalMap,
    registerOffline: registerOfflineInLocalMap,
    replaceLiveWithOfflineForSession: internalReplaceLiveWithOffline,
    unregisterSession: internalUnregisterSession,
    unregisterAgent: internalUnregisterAgent,
    liveSessionIdByAgent,
    deliveryKeyForSession,
    tryInjectSessionMessage: internalTryInjectSessionMessage,
    recordDeliveryFailure: recordLocalSessionDeliveryFailureForTest,
    listOwners: internalListOwners,
    waitUntilReady: waitForLocalSessionAdmission,
    isSessionTurnInFlight: isLocalSessionTurnInFlight,
  }
}

function liveSessionIdByAgent(agentUserId: string): string | null {
  return bindingsByAgent.get(agentUserId)?.sessionId ?? offlineBindingsByAgent.get(agentUserId)?.sessionId ?? null
}

function deliveryKeyForSession(sessionId: string): string | null {
  return agentsBySession.has(sessionId) || offlineAgentsBySession.has(sessionId) ? sessionId : null
}

async function waitForLocalSessionAdmission(sessionId: string): Promise<void> {
  const agentUserId = agentsBySession.get(sessionId)
  const binding = agentUserId ? bindingsByAgent.get(agentUserId) : undefined
  if (!binding?.waitUntilReady) {
    throw new Error(`local-session ${sessionId} has no live native admission waiter`)
  }
  await binding.waitUntilReady()
  if (bindingsByAgent.get(agentUserId!) !== binding || agentsBySession.get(sessionId) !== agentUserId) {
    throw new Error(`local-session ${sessionId} owner changed during admission`)
  }
}

function isLocalSessionTurnInFlight(sessionId: string): boolean {
  const agentUserId = agentsBySession.get(sessionId)
  const binding = agentUserId ? bindingsByAgent.get(agentUserId) : undefined
  // No live owner, no turn of this owner's — the same answer the app-server and serve owners give,
  // and the only one that does not reject the coordinator's gate when a PTY exits mid-question.
  if (!binding) return false
  if (!binding.isTurnInFlight) {
    throw new Error(`local-session ${sessionId} has no live turn activity source`)
  }
  return binding.isTurnInFlight()
}
