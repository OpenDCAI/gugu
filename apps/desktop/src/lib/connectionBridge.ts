import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ConnectionClient } from '@gugu/core/cloud/connections'
import { ConnectionError } from '@gugu/core/cloud/connections'
import type { ConnectionMetadataStore } from '@/components/connections/connection-metadata'

/** Installed by the authenticated shell, before either settings bundle mounts. */
export interface ConnectionBridge {
  accountId(): string | null
  subscribeAccount(listener: () => void): () => void
  metadata(ownerId: string, deviceId?: string | null): ConnectionMetadataStore
  client: ConnectionClient
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

export function useOwnerConnectionStore(deviceId: string | null = null) {
  const owner = useSyncExternalStore(subscribeAccount,accountId,() => null)
  const store = useMemo(() => owner ? connectionBridge().metadata(owner,deviceId) : undefined,[owner,deviceId])
  useEffect(() => owner && store ? connectionBridge().subscribeChanges(owner,() => store.invalidate()) : undefined,[owner,store])
  return store
}
