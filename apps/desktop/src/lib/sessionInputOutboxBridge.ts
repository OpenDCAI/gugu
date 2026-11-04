import { useMemo, useSyncExternalStore } from 'react'
import type { SessionInputOutbox, SessionInput } from './sessionInputOutbox'
import { rendererLogger } from './log'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { sessionInputBaseline } from './pendingSessionInput'
import { nativeMessageKey } from '@gugu/session-core/session-record/native-read'
import { liveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { translateSessionMessage } from '@renderer/localization/locale-store'

type State = { accountId: string | null; queue: Promise<SessionInputOutbox> | null; rows: readonly SessionInput[]; listeners: Set<() => void>; valid: () => boolean }
const KEY = '__GUGU_NATIVE_INPUT_OUTBOX__'
export const EMPTY: readonly SessionInput[] = []
const fallback: State = { accountId: null, queue: null, rows: EMPTY, listeners: new Set(), valid: () => false }
export const state = (): State => {
  if (typeof window === 'undefined') return fallback
  const host = window as unknown as Record<string, unknown>
  return (host[KEY] ??= { accountId: null, queue: null, rows: EMPTY, listeners: new Set(), valid: () => false }) as State
}
export const changed = () => { for (const listener of state().listeners) listener() }
export const sessionInputOutboxAvailable = (): boolean => Boolean(state().queue && state().valid())

export async function enqueueSessionInput(target: Pick<SessionInput, 'deviceId' | 'sessionId' | 'text' | 'files' | 'attachments' | 'queued' | 'baseline' | 'afterTurnId' | 'sendQueue'> & { composer?: true }): Promise<SessionInput> {
  const own = state()
  if (!own.queue || !own.valid()) throw new Error('Session input outbox is not available for this account')
  const queue = await own.queue
  const input = await queue.enqueue(target)
  void queue.flush().catch(error => rendererLogger('session/input-outbox').warn({ error: String(error) }, 'Could not flush native input'))
  return input
}

/** The person asked to send the failed inputs again now (the outbox also retries on its own schedule). */
export async function retrySessionInputs(): Promise<void> {
  const own = state()
  if (!own.queue || !own.valid()) throw new Error('Session input outbox is not available for this account')
  await (await own.queue).flush(true)
}

export async function changeRejectedSessionInput(id: string, action: { kind: 'retry' } | { kind: 'edit'; text: string } | { kind: 'discard' }): Promise<void> {
  const own = state()
  if (!own.queue || !own.valid()) throw new Error('Session input outbox is not available for this account')
  const queue = await own.queue
  if (action.kind === 'edit') await queue.edit(id, action.text)
  else if (action.kind === 'retry') await queue.retry(id)
  else await queue.discard(id)
}

async function currentQueue(): Promise<SessionInputOutbox> {
  const own = state()
  if (!own.queue || !own.valid()) throw new Error('Session input outbox is not available for this account')
  return own.queue
}

export async function editQueuedSessionInput(id: string, text: string, edit?: { draftText: string; originalDraftText: string } | null): Promise<boolean> {
  return (await currentQueue()).changeQueued(id, { text, ...(edit === undefined ? {} : { edit }) })
}

export async function deleteQueuedSessionInput(id: string): Promise<boolean> {
  return (await currentQueue()).changeQueued(id, 'delete')
}

export async function reorderQueuedSessionInputs(sessionId: string, ids: readonly string[]): Promise<void> {
  return (await currentQueue()).reorderQueued(sessionId, ids)
}

/** Call only with an authoritative foreground-idle snapshot, or the person's explicit send-now action. */
export async function releaseQueuedSessionInput(sessionId: string, turns: readonly TranscriptTurn[], nowId?: string, steers = false, canRelease: () => boolean = () => true): Promise<SessionInput | null> {
  if (steers && !Object.values(liveDeviceSessions()).some(host => !host.cached && host.sessions.some(session => session.conversationId === sessionId && session.nativeInputSteering === true))) {
    throw new Error(translateSessionMessage('composer.steeringHostUpdateRequired'))
  }
  const completed = new Set<string>()
  for (const turn of turns) if (turn.outcome) for (const item of turn.items) if (item.kind === 'message' && item.role === 'user') {
    completed.add(nativeMessageKey(item.id))
    if (typeof item._meta?.guguClientMessageId === 'string') completed.add(item._meta.guguClientMessageId)
  }
  const queue = await currentQueue()
  const input = await queue.releaseQueued(sessionId, sessionInputBaseline(turns), completed, nowId, steers, canRelease)
  if (input) void queue.flush().catch(error => rendererLogger('session/input-outbox').warn({ error: String(error) }, 'Could not flush released input'))
  return input
}

export function useQueuedSessionInputs(sessionId: string): readonly SessionInput[] {
  const rows = useSyncExternalStore(listener => { state().listeners.add(listener); return () => { state().listeners.delete(listener) } }, () => state().rows, () => EMPTY)
  const ownerId = state().valid() ? state().accountId : null
  return useMemo(() => rows.filter(row => row.sessionId === sessionId && row.accountId === ownerId), [rows, sessionId, ownerId])
}

/** Non-React transcript stores observe the same account-scoped sender rows as the phone. */
export function queuedSessionInputs(sessionId: string): readonly SessionInput[] {
  const own = state()
  return own.valid() ? own.rows.filter(row => row.sessionId === sessionId && row.accountId === own.accountId) : EMPTY
}

export function subscribeSessionInputs(listener: () => void): () => void {
  state().listeners.add(listener)
  return () => { state().listeners.delete(listener) }
}


export function useSessionInputAccount(): string | null {
  return useSyncExternalStore(listener => { state().listeners.add(listener); return () => { state().listeners.delete(listener) } },
    () => state().valid() ? state().accountId : null, () => null)
}
