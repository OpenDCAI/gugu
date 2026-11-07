import { ConnectionError } from '@gugu/core/cloud/connections'
import type { ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import { connectionBridge } from '@/lib/connectionBridge'
import type { ConnectionMetadataStore } from './connection-metadata'

/** Preserve an original legacy attempt without redirecting its late result. */
export function createLegacyConnectionGuard() {
  let route: Promise<ConnectionRoute> | undefined
  return async (mutation = false) => {
    const routing = connectionBridge().routing
    route ??= routing.read()
    const original = await route
    if (original.mode !== 'legacy') throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
    await routing.assert(original,mutation)
  }
}

export function legacyConnectionMetadata<Store extends ConnectionMetadataStore>(panel: Store,guard: ReturnType<typeof createLegacyConnectionGuard>): Store {
  const run = async <T>(write: boolean,action: () => Promise<T>): Promise<T> => {
    await guard(write); const result = await action(); await guard(); return result
  }
  return { ...panel,assertCurrent: async () => { await panel.assertCurrent(); await guard() },
    snapshot: () => run(false,() => panel.snapshot()),collection: domain => run(false,() => panel.collection(domain)),
    body: item => run(false,() => panel.body(item)),change: (item,operation) => run(true,() => panel.change(item,operation)),
    save: (item,data) => run(true,() => panel.save(item,data)),
  } as Store
}
