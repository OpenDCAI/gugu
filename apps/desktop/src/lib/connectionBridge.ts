import { useEffect,useMemo,useSyncExternalStore,useCallback,useRef,useState } from 'react'
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
  const [result,setResult] = useState<{ owner: string; route?: ConnectionRoute; error?: unknown }>(),request = useRef(0)
  const invalidate = useCallback(() => { request.current++ },[])
  const reload = useCallback(async () => {
    const current = ++request.current
    if (!owner) return
    try {
      const route = await connectionBridge().routing.read()
      if (request.current === current && accountId() === owner) setResult({ owner,route })
    } catch (error) { if (request.current === current && accountId() === owner) setResult({ owner,error }) }
  },[owner])
  useEffect(() => {
    if (!owner) return
    const refresh = () => { void reload() }
    const stop = connectionBridge().subscribeChanges(owner,refresh),timer = setInterval(refresh,15_000)
    window.addEventListener('focus',refresh); refresh()
    return () => { invalidate(); stop(); clearInterval(timer); window.removeEventListener('focus',refresh) }
  },[owner,reload,invalidate])
  const current = result?.owner === owner ? result : undefined
  return { owner,route: current?.route,error: current?.error,reload,loading: !current }
}

export function useOwnerConnectionStore(deviceId: string | null = null,route?: ConnectionRoute,enabled = true) {
  const owner = useSyncExternalStore(subscribeAccount,accountId,() => null)
  const store = useMemo(() => owner && enabled ? connectionBridge().metadata(owner,deviceId,route) : undefined,[owner,deviceId,route,enabled])
  useEffect(() => owner && store ? connectionBridge().subscribeChanges(owner,() => store.invalidate()) : undefined,[owner,store])
  return store
}
