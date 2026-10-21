import type { Session } from '@supabase/supabase-js'
import { dataClient } from './supabase'
import { getRendererSession, observeRendererSession } from './sessionPublication'

type RealtimeAuthChangeEvent = {
  event: string
  session: Session | null
}

type RealtimeAuthListener = (change: RealtimeAuthChangeEvent) => void
type RealtimeAuthPushedListener = () => void

const authListeners = new Set<RealtimeAuthListener>()
const authPushedListeners = new Set<RealtimeAuthPushedListener>()
let listenerInstalled = false
let pushedToken: string | null | undefined
let authQueue: Promise<void> = Promise.resolve()

export function observeRealtimeAuth(listener: RealtimeAuthListener): () => void {
  installAuthListener()
  authListeners.add(listener)
  return () => authListeners.delete(listener)
}

export function onRealtimeAuthPushed(listener: RealtimeAuthPushedListener): () => void {
  authPushedListeners.add(listener)
  return () => authPushedListeners.delete(listener)
}

export async function ensureRealtimeAuth(): Promise<void> {
  installAuthListener()
  await pushRealtimeAuth(getRendererSession()?.access_token ?? null)
}

function installAuthListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  observeRendererSession(({ event, session }) => {
    void pushRealtimeAuth(session?.access_token ?? null).catch((error) => {
      console.error('[Realtime] auth sync error', error)
    })
    const change = { event, session }
    authListeners.forEach((listener) => listener(change))
  })
}

function pushRealtimeAuth(token: string | null): Promise<void> {
  // @@@single-realtime-auth-writer - All renderer Realtime token writes go through
  // this queue so channel callers cannot race each other with stale credentials.
  authQueue = authQueue
    .catch(() => undefined)
    .then(async () => {
      if (pushedToken === token) return
      if (token) {
        await dataClient.realtime.setAuth(token)
      } else {
        await dataClient.realtime.setAuth()
      }
      pushedToken = token
      authPushedListeners.forEach((listener) => listener())
    })
  return authQueue
}
