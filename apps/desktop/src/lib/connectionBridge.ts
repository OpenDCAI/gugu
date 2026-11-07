import { useEffect,useMemo,useSyncExternalStore,useCallback,useRef,useState } from 'react'
import { connectionReadDelay } from '@/components/connections/connection-read-policy'
import { useConnectionReadNotice } from '@/components/connections/useConnectionReadNotice'
import { rendererLogger } from '@/lib/log'
import type { ConnectionClient } from '@gugu/core/cloud/connections'
import { ConnectionError } from '@gugu/core/cloud/connections'
import type { ConnectionMetadataStore } from '@/components/connections/connection-metadata'
import type { ConnectionRoute,createConnectionRouting } from '@gugu/core/cloud/connectionRouting'

/** Installed by the authenticated shell, before either settings bundle mounts. */
export interface ConnectionBridge {
  accountId(): string | null
  subscribeAccount(listener: () => void): () => void
  metadata(ownerId: string, deviceId?: string | null,route?: ConnectionRoute): ConnectionMetadataStore
  client: ConnectionClient
  routing: ReturnType<typeof createConnectionRouting>
  subscribeChanges(ownerId: string, listener: () => void): () => void
  retryOperation(operationId: string): Promise<void>
}
const KEY = '__GUGU_CONNECTIONS__' as const
export type ConnectionWindow = Window & { [KEY]?: ConnectionBridge }
export function connectionBridge(): ConnectionBridge {
  const bridge = typeof window === 'undefined' ? undefined : (window as ConnectionWindow)[KEY]
  if (!bridge) throw new ConnectionError('missing-identity','CONNECTION_SHELL_UNAVAILABLE')
  return bridge
}
const accountId = () => typeof window === 'undefined' ? null : (window as ConnectionWindow)[KEY]?.accountId() ?? null
const subscribeAccount = (listener: () => void) => typeof window === 'undefined' ? () => {} : (window as ConnectionWindow)[KEY]?.subscribeAccount(listener) ?? (() => {})

export function useConnectionAuthority() {
  const owner = useSyncExternalStore(subscribeAccount,accountId,() => null)
  const [result,setResult] = useState<{ owner: string; route?: ConnectionRoute; error?: unknown; failures?: number }>(),request = useRef(0)
  const invalidate = useCallback(() => { request.current++ },[])
  const reload = useCallback(async () => {
    const current = ++request.current
    if (!owner) return
    try {
      const route = await connectionBridge().routing.read()
      if (request.current === current && accountId() === owner) setResult({ owner,route }); return true
    } catch (error) {
      rendererLogger('connections').warn({ code: (error as { code?: string } | null)?.code },'Authority read will retry')
      if (request.current === current && accountId() === owner) setResult(previous => ({ owner,error,
        route: previous?.owner === owner ? previous.route : undefined,failures: (previous?.owner === owner ? previous.failures ?? 0 : 0)+1 }))
      return false
    }
  },[owner])
  const current = result?.owner === owner ? result : undefined
  useConnectionReadNotice(`authority:${owner}`,!!current?.route,current?.failures ?? 0)
  useEffect(() => {
    if (!owner) return
    let stopped = false,timer: ReturnType<typeof setTimeout> | undefined,failures = 0,running = false
    const refresh = async () => {
      if (running || stopped) return
      running = true
      clearTimeout(timer)
      try {
        const success = await reload()
        failures = success ? 0 : failures + 1
      } finally {
        running = false
        if (!stopped) timer = setTimeout(() => void refresh(),failures ? connectionReadDelay(failures-1) : 15_000)
      }
    }
    const stop = connectionBridge().subscribeChanges(owner,() => { void refresh() })
    const focus = () => { void refresh() }
    window.addEventListener('focus',focus); void refresh()
    return () => { stopped = true; invalidate(); stop(); clearTimeout(timer); window.removeEventListener('focus',focus) }
  },[owner,reload,invalidate])
  return { owner,route: current?.route,error: current?.error,reload,loading: !current }
}

export function useOwnerConnectionStore(deviceId: string | null = null,route?: ConnectionRoute,enabled = true) {
  const owner = useSyncExternalStore(subscribeAccount,accountId,() => null)
  const store = useMemo(() => owner && enabled ? connectionBridge().metadata(owner,deviceId,route) : undefined,[owner,deviceId,route,enabled])
  useEffect(() => owner && store ? connectionBridge().subscribeChanges(owner,() => store.invalidate()) : undefined,[owner,store])
  return store
}
