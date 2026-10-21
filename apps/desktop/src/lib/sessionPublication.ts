import type { Session } from '@supabase/supabase-js'

export type RendererSessionChange = {
  event: string
  session: Session | null
}

type Listener = (change: RendererSessionChange) => void

let current: RendererSessionChange = { event: 'BOOT_RESTORING', session: null }
const listeners = new Set<Listener>()

export function publishRendererSession(event: string, session: Session | null): void {
  current = { event, session }
  listeners.forEach((listener) => listener(current))
}

export function getRendererSession(): Session | null {
  return current.session
}

export function getRendererAccessToken(): string | null {
  return current.session?.access_token ?? null
}

export function observeRendererSession(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
