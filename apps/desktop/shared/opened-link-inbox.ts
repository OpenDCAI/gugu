import { isOAuthCallback } from './oauth-callback'

/** The OS has one URL stream. Keep login callbacks separate from post-login navigation without
 * adding another appUrlOpen listener or losing a cold launch while the account is restoring. */
export class OpenedLinkInbox {
  private readonly pending = { auth: [] as string[], navigation: [] as string[] }
  private readonly listeners = { auth: new Set<(url: string) => void>(), navigation: new Set<(url: string) => void>() }
  push(url: string): void {
    const kind = isOAuthCallback(url) ? 'auth' : 'navigation'
    const listeners = this.listeners[kind]
    if (!listeners.size) this.pending[kind].push(url)
    else for (const listener of listeners) listener(url)
  }
  clear(kind: 'auth' | 'navigation'): void { this.pending[kind].length = 0 }
  subscribe(kind: 'auth' | 'navigation', listener: (url: string) => void): () => void {
    this.listeners[kind].add(listener)
    for (const url of this.pending[kind].splice(0)) listener(url)
    return () => { this.listeners[kind].delete(listener) }
  }
}
