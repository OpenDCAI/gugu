import { ConnectionError,type ConnectionAuthority,type ConnectionClient } from './connections'

/** Normalized client routing value; the transport maps the server contract. */
export type ConnectionRoute = Readonly<Omit<ConnectionAuthority,'version'>>
export type ConnectionRouteBinding = Readonly<ConnectionRoute & { ownerId: string; key: string; assertCurrent(): Promise<void> }>

/** Errors are never mode probes. A captured action cannot switch its source
 * after a late result, account switch or server authority change. */
export function createConnectionRouting(input: {
  accountId(): string | null; read(): Promise<ConnectionRoute>; changed(ownerId: string,route: ConnectionRoute): void
}) {
  const cached = new Map<string,ConnectionRoute>()
  const pending = new Map<string,Promise<ConnectionRoute>>()
  function read(): Promise<ConnectionRoute> {
    const owner = input.accountId()
    if (!owner) return Promise.reject(new ConnectionError('signed-out','CONNECTION_SIGNED_OUT'))
    const active = pending.get(owner)
    if (active) return active
    const next = fetchRoute().finally(() => { if (pending.get(owner) === next) pending.delete(owner) })
    pending.set(owner,next)
    return next
  }
  async function fetchRoute(): Promise<ConnectionRoute> {
    const ownerId = input.accountId()
    if (!ownerId) throw new ConnectionError('signed-out','CONNECTION_SIGNED_OUT')
    const route = await input.read()
    if (input.accountId() !== ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
    if (!['legacy','owner'].includes(route.mode) || !/^\d+$/.test(route.epoch) || !['stable','quiescing'].includes(route.phase)
      || typeof route.acceptingNewOperations !== 'boolean' || route.phase === 'quiescing' && route.acceptingNewOperations)
      throw new ConnectionError('invalid-response','CONNECTION_ROUTING_INVALID')
    const previous = cached.get(ownerId)
    if (previous && BigInt(previous.epoch) > BigInt(route.epoch)) throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
    if (previous?.epoch === route.epoch && previous.mode !== route.mode) throw new ConnectionError('invalid-response','CONNECTION_ROUTING_INVALID')
    const value = previous && previous.epoch === route.epoch && previous.mode === route.mode && previous.phase === route.phase
      && previous.acceptingNewOperations === route.acceptingNewOperations ? previous : Object.freeze({ ...route })
    cached.set(ownerId,value)
    if (previous?.epoch !== value.epoch || previous?.mode !== value.mode || previous.phase !== value.phase
      || previous.acceptingNewOperations !== value.acceptingNewOperations) input.changed(ownerId,value)
    return value
  }
  async function capture(): Promise<ConnectionRouteBinding> {
    const ownerId = input.accountId()
    const route = await read()
    if (route.phase !== 'stable' || !route.acceptingNewOperations) throw new ConnectionError('quiescing','CONNECTION_CUTOVER_IN_PROGRESS')
    if (!ownerId || input.accountId() !== ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
    return Object.freeze({ ...route,ownerId,key: JSON.stringify([ownerId,route.mode,route.epoch]),async assertCurrent() {
      if (input.accountId() !== ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
      const current = await read()
      if (current.mode !== route.mode || current.epoch !== route.epoch) throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
      if (current.phase !== 'stable' || !current.acceptingNewOperations) throw new ConnectionError('quiescing','CONNECTION_CUTOVER_IN_PROGRESS')
    } })
  }
  async function assert(expected: ConnectionRoute, mutation = false) {
    const current = await read()
    if (current.mode !== expected.mode || current.epoch !== expected.epoch) throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
    if (mutation && (current.phase !== 'stable' || !current.acceptingNewOperations)) throw new ConnectionError('quiescing','CONNECTION_CUTOVER_IN_PROGRESS')
  }
  return { read,capture,assert,peek: () => { const owner = input.accountId(); return owner ? cached.get(owner) : undefined },
    async run<Result>(actions: { legacy(binding: ConnectionRouteBinding): Promise<Result>; owner(binding: ConnectionRouteBinding): Promise<Result> }) {
      const binding = await capture()
      const result = await actions[binding.mode](binding)
      await binding.assertCurrent()
      return result
    },
  }
}

/** A captured route is never refreshed into another writable source. Completed
 * acknowledgements can drain during quiescing; new intents/effects cannot. */
export function connectionClientForRoute(client: ConnectionClient,routing: Pick<ReturnType<typeof createConnectionRouting>,'assert'>,route: ConnectionRoute): ConnectionClient {
  const newOperations = new Set(['commit','commitBatch','recreateBegin','admit'])
  return Object.fromEntries(Object.entries(client).map(([name,action]) => [name,name === 'authority' ? action : async (...args: unknown[]) => {
    await routing.assert(route,newOperations.has(name))
    const result = await (action as (...args: unknown[]) => Promise<unknown>)(...args)
    await routing.assert(route)
    return result
  }])) as ConnectionClient
}
