import { createConnectionClient, ConnectionError, type ConnectionChange, type NativeConnectionAuthorization,type NativeConnectionAuthorizationBatch } from '@gugu/core/cloud/connections'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { withBoundedOperation } from '@gugu/core/cloud/boundedOperation'
import type { assistantPanelLocal } from '../session/main/core/app/assistant-panel-local'
import { createConnectionOperationApplication, ConnectionEffectRefused, type ConnectionEffect } from './connection-operation-application'
import { createConnectionOperationLedger } from './connection-operation-ledger'
import { createConnectionObservationHolds } from './connection-observation-holds'
import { publishConnectionObservations, type ConnectionObservation } from './connection-publication'
import { createConnectionAuthorizationRequests } from './connection-authorization-requests'
import { createConnectionRouting,connectionClientForRoute,type ConnectionRoute } from '@gugu/core/cloud/connectionRouting'

type Auth = { accessToken: string; userId: string }

/** The existing desktop/server runtime owns this worker. It never starts an
 * assistant, opens a home or acquires a new device/runtime lease. */
export function createConnectionRuntime(input: {
  getAuth(): Promise<Auth | null>; instanceId(): string | null; deviceId(): Promise<string>
  local: Pick<typeof assistantPanelLocal,'applyConnection'> & Partial<Pick<typeof assistantPanelLocal,'integrations' | 'integrationCatalog' | 'integrationCustody' | 'onIntegrationsChanged'>>; guguHome: string
  failed?(error: unknown): void
}) {
  let active: { ownerId: string; deviceId: string; worker: ReturnType<typeof worker> } | undefined
  let tail: Promise<unknown> = Promise.resolve()
  let disposed = false
  const getAuth = () => withBoundedOperation(2000,() => new ConnectionError('read-timeout','CONNECTION_AUTH_TIMEOUT'),input.getAuth)
  async function current() {
    if (disposed) throw new ConnectionError('disposed','CONNECTION_RUNTIME_DISPOSED')
    const auth = await getAuth()
    if (!auth) { active = undefined; return null }
    const deviceId = await input.deviceId()
    if (active?.ownerId !== auth.userId || active.deviceId !== deviceId) active = { ownerId: auth.userId,deviceId,worker: worker(auth.userId,deviceId) }
    return active.worker
  }
  function worker(ownerId: string, deviceId: string) {
    async function auth() {
      const value = await getAuth()
      if (disposed || value?.userId !== ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
      return value
    }
    const rawCloud = createConnectionClient(async (name,args) => {
      const value = await auth()
      const result = await createGuguSupabaseClient({ schema: 'identity',headers: { Authorization: `Bearer ${value.accessToken}` } })
        .rpc(name,args).abortSignal(AbortSignal.timeout(10_000))
      await auth()
      return result
    },() => disposed ? null : ownerId)
    const routing = createConnectionRouting({ accountId: () => disposed ? null : ownerId,read: () => rawCloud.authority(),changed: () => {} })
    let route: ConnectionRoute | undefined,cloud = rawCloud
    async function selectOwner(expectedEpoch?: string) {
      const current = await routing.read()
      if (current.mode !== 'owner') {
        if (expectedEpoch !== undefined) throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
        return false
      }
      if (expectedEpoch !== undefined && current.epoch !== expectedEpoch) throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
      if (current.phase !== 'stable' || !current.acceptingNewOperations) throw new ConnectionError('quiescing','CONNECTION_CUTOVER_IN_PROGRESS')
      route = current; cloud = connectionClientForRoute(rawCloud,routing,current)
      return true
    }
    const ledger = createConnectionOperationLedger({ guguHome: input.guguHome,ownerId,deviceId,assertCurrent: async () => { await auth() } })
    const holds = createConnectionObservationHolds({ guguHome: input.guguHome,ownerId,deviceId,assertCurrent: async () => { await auth() } })
    const authorizationRequest = createConnectionAuthorizationRequests({ guguHome: input.guguHome,ownerId,deviceId,assertCurrent: async () => { await auth() } })
    function instance() {
      const id = input.instanceId()
      if (!id) throw new ConnectionError('runtime-unavailable','CONNECTION_RUNTIME_UNAVAILABLE')
      return id
    }
    let expectedHead = '0'
    const application = createConnectionOperationApplication({ deviceId,
      authorityEpoch: () => route?.epoch,
      assertCurrent: async () => { await auth() },load: ledger.load,save: ledger.save,
      admit: async effect => {
        const result = await cloud.admit(instance(),expectedHead,effect.operationId)
        expectedHead = result.revision
        if (!result.admitted) return null
        if (result.requestHash !== effect.requestHash || result.operationRevision !== effect.revision || !result.admissionId)
          throw new ConnectionError('invalid-response','CONNECTION_ADMISSION_MISMATCH')
        return result.admissionId
      },
      apply: async effect => {
        if (!route) throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
        await routing.assert(route,true)
        if (effect.validationError) throw new ConnectionEffectRefused(effect.validationError)
        try { await input.local.applyConnection({ operation: effect.operation,data: effect.data }) }
        catch (error) {
          const known = error as { knownNoEffect?: boolean; code?: string }
          if (known.knownNoEffect && typeof known.code === 'string') throw new ConnectionEffectRefused(known.code)
          throw error
        }
      },
      acknowledge: async (effect,admissionId,errorCode) => {
        const receipt = await cloud.ack(instance(),effect.operationId,admissionId,errorCode,errorCode !== null)
        expectedHead = receipt.revision
      },
    })
    function effect(change: ConnectionChange): ConnectionEffect {
      if (change.scopeKey !== `device:${deviceId}` || change.deviceId !== deviceId) throw new ConnectionError('42501','CONNECTION_DEVICE_MISMATCH')
      const data = change.payload[change.operation === 'remove' ? 'before' : 'data']
      const valid = !!data && typeof data === 'object' && !Array.isArray(data)
      return { operationId: change.operationId,requestHash: change.requestHash,revision: change.revision,
        resourceKey: change.resourceKey,deviceId,operation: change.operation,data: valid ? data as Record<string,unknown> : {},
        ...(!valid ? { validationError: 'CONNECTION_DATA_INVALID' } : {}),
        ...(change.admissionId ? { admissionId: change.admissionId } : {}),
      }
    }
    async function prepare(expectedEpoch?: string) {
      if (!await selectOwner(expectedEpoch)) return
      const snapshot = await cloud.snapshot(deviceId)
      // Unactivated candidates do not interrupt the original credential path or
      // become a second writable source. Activation itself is backend-owned.
      if (snapshot.state !== 'ready') return
      if (snapshot.application.some(change => change.errorCode === 'CONNECTION_OUTCOME_UNKNOWN'))
        throw new ConnectionEffectRefused('CONNECTION_OUTCOME_UNKNOWN')
      for (let pass = 0; pass < 12; pass++) {
        const pending = await cloud.pending(instance())
        expectedHead = pending.revision
        for (const change of pending.changes) {
          if (change.terminal) continue
          await application.apply(effect(change))
        }
        const barrier = await cloud.admit(instance(),expectedHead)
        if (barrier.admitted) {
          // Observation failures cannot replace a passed execution barrier.
          // In particular another device may own an unfinished explicit intent.
          await publish().catch(error => input.failed?.(error))
          return
        }
        if (barrier.errorCode === 'CONNECTION_OUTCOME_UNKNOWN') throw new ConnectionEffectRefused('CONNECTION_OUTCOME_UNKNOWN')
      }
      throw new ConnectionError('PT409','CONNECTION_CONCURRENT_CHANGES')
    }
    async function publish() {
      if (!input.local.integrations) return
      const held = await holds.load()
      const observations: ConnectionObservation[] = []
      for (const row of input.local.integrationCatalog?.() ?? []) {
        if (held[row.id]) continue
        observations.push({ scopeKey: `device:${deviceId}`,resourceKey: `catalog:${row.id}`,deviceId,
          data: { providerId: row.id,configured: false,displayName: row.en.name,...(row.en.catalog ? { catalog: row.en.catalog } : {}) },document: JSON.stringify({ version: 1,en: row.en,'zh-CN': row.zh }) })
      }
      for (const { publicMetadata,...data } of await input.local.integrations(ownerId,schedule)) {
        if (held[data.providerId]) continue
        const platform = input.local.integrationCustody?.(data.providerId) === 'platform'
        observations.push({ scopeKey: platform ? 'platform' : `device:${deviceId}`,deviceId: platform ? null : deviceId,data,
          document: JSON.stringify(publicMetadata) })
      }
      await publishConnectionObservations({ snapshot: await cloud.snapshot(deviceId),observations,client: cloud,runtimeInstanceId: instance() })
    }
    async function authorizedAccount(providerId: string,accountId: string) {
      const rows = await input.local.integrations?.(ownerId)
      const account = rows?.find(row => row.providerId === providerId && row.accountId === accountId)
      if (!account || input.local.integrationCustody?.(providerId) === 'platform') throw new ConnectionError('authorization-required','CONNECTION_AUTHORIZATION_REQUIRED')
      const { publicMetadata,...data } = account
      return { data,document: JSON.stringify(publicMetadata) }
    }
    async function commitAuthorization(intent: NativeConnectionAuthorization) {
      if (typeof intent.authorityEpoch !== 'string') throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
      await selectOwner(intent.authorityEpoch)
      if (intent.scopeKey !== `device:${deviceId}`) throw new ConnectionError('42501','CONNECTION_DEVICE_MISMATCH')
      const change = await authorizationRequest(intent.operationId,intent,async () => ({ operationId: intent.operationId,scopeKey: intent.scopeKey,
        resourceKey: intent.resourceKey,expectedRevision: intent.expectedRevision,operation: 'save' as const,
        ...await authorizedAccount(intent.providerId,intent.accountId),deviceId,recreationId: intent.recreationId }))
      return cloud.commit({ ...change,runtimeInstanceId: instance() })
    }
    async function commitAuthorizationBatch(intent: NativeConnectionAuthorizationBatch) {
      if (typeof intent.authorityEpoch !== 'string') throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
      await selectOwner(intent.authorityEpoch)
      const change = await authorizationRequest(intent.operationId,intent,async () => ({ operationId: intent.operationId,recreationId: intent.recreationId,
        operations: await Promise.all(intent.operations.map(async operation => ({ operationId: operation.operationId,
          ...await authorizedAccount(intent.providerId,operation.accountId) }))) }))
      return cloud.commitBatch({ ...change,runtimeInstanceId: instance() })
    }
    return { authority: routing.read,prepare,async hold(provider: string,id: string,expectedEpoch?: string) {
      if (!await selectOwner(expectedEpoch)) throw new ConnectionError('route-changed','CONNECTION_ROUTE_CHANGED')
      return holds.begin(provider,id)
    },release: holds.release,commitAuthorization,commitAuthorizationBatch }
  }
  function serial<T>(action: (worker: NonNullable<typeof active>['worker']) => Promise<T>) {
    const result = tail.catch(() => undefined).then(async () => {
      const selected = await current()
      if (!selected) throw new ConnectionError('signed-out','CONNECTION_SIGNED_OUT')
      return action(selected)
    })
    tail = result
    return result
  }
  const prepare = (expectedEpoch?: string) => serial(worker => worker.prepare(expectedEpoch))
  let scheduled: NodeJS.Timeout | undefined
  function schedule() {
    if (disposed) return
    clearTimeout(scheduled)
    scheduled = setTimeout(() => { void prepare().catch(error => input.failed?.(error)) },100)
    scheduled.unref()
  }
  const stop = input.local.onIntegrationsChanged?.(schedule)
  // Reconnect/poll repair does not depend on an assistant or a renderer. Legacy
  // mode performs only the explicit authority read, never owner application RPCs.
  const refresh = setInterval(() => { if (input.instanceId()) schedule() },15_000)
  refresh.unref()
  return { prepare,authority: () => serial(worker => worker.authority()),
    hold: (provider: string,id: string,expectedEpoch?: string) => serial(worker => worker.hold(provider,id,expectedEpoch)),
    release: (provider: string,id: string) => serial(worker => worker.release(provider,id)),
    commitAuthorization: (intent: NativeConnectionAuthorization) => serial(worker => worker.commitAuthorization(intent)),
    commitAuthorizationBatch: (intent: NativeConnectionAuthorizationBatch) => serial(worker => worker.commitAuthorizationBatch(intent)),
    dispose() { disposed = true; active = undefined; clearTimeout(scheduled); clearInterval(refresh); stop?.() },
  }
}
