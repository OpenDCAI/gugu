import { useMemo, useSyncExternalStore } from 'react'
import type { SessionInputOutbox, SessionInput } from './sessionInputOutbox'
import { rendererLogger } from './log'

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

export async function enqueueSessionInput(target: Pick<SessionInput, 'deviceId' | 'sessionId' | 'text' | 'attachments'>): Promise<SessionInput> {
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
  await (await own.queue).flush()
}

export function useQueuedSessionInputs(sessionId: string): readonly SessionInput[] {
  const rows = useSyncExternalStore(listener => { state().listeners.add(listener); return () => { state().listeners.delete(listener) } }, () => state().rows, () => EMPTY)
  const ownerId = state().valid() ? state().accountId : null
  return useMemo(() => rows.filter(row => row.sessionId === sessionId && row.accountId === ownerId), [rows, sessionId, ownerId])
}


export function useSessionInputAccount(): string | null {
  return useSyncExternalStore(listener => { state().listeners.add(listener); return () => { state().listeners.delete(listener) } },
    () => state().valid() ? state().accountId : null, () => null)
}
