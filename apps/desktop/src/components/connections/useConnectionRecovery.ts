import { useEffect } from 'react'
import { connectionBridge } from '@/lib/connectionBridge'
import { rendererLogger } from '@/lib/log'
import type { ConnectionMetadataStore } from './connection-metadata'
import { connectionReadDelay } from './connection-read-policy'

/** Retry the original durable UUID, never recreate an intent or replay an unknown effect. */
export function useConnectionRecovery(store: ConnectionMetadataStore | undefined,allowed: boolean) {
  useEffect(() => {
    if (!store || !allowed) return
    let stopped = false,failures = 0,timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      let failed = false
      const snapshot = store.peekSnapshot?.()
      for (const operation of snapshot?.application ?? []) {
        if (stopped || connectionBridge().accountId() !== store.ownerId) return
        const item = snapshot?.items.find(row => row.resource_key === operation.resourceKey)
        if (item?.source?.scopeKey !== 'platform' || operation.operation !== 'remove' || operation.terminal
          || operation.status !== 'pending' || (operation as typeof operation & { wireStatus?: string }).wireStatus === 'started'
          || operation.errorCode === 'CONNECTION_OUTCOME_UNKNOWN') continue
        try { await connectionBridge().retryOperation(operation.operationId) }
        catch (error) { failed = true; rendererLogger('connections').warn({ code: (error as { code?: string } | null)?.code },'Platform operation will retry with its original identity') }
        if (!stopped) store.invalidate()
      }
      failures = failed ? failures + 1 : 0
      if (!stopped) timer = setTimeout(() => void run(),failed ? connectionReadDelay(failures) : 3000)
    }
    timer = setTimeout(() => void run(),3000)
    return () => { stopped = true; clearTimeout(timer) }
  },[store,allowed])
}
