import { it,expect } from 'vitest'
import { connectionApplicationStatus } from '@/components/connections/connection-application-status'
import { withConnectionVerification } from '@/components/connections/connection-verification-presentation'
import type { ConnectionMetadataSnapshot } from '@/components/connections/connection-metadata'
import type { ConnectionOperationStatus } from '@gugu/core/cloud/connectionOperationStatus'
const operationId = '10000000-0000-4000-8000-000000000001'
const record = { operationId,providerId: 'asana',scopeKey: 'device:one',resourceKey: null,deviceId: 'one',operation: 'save' as const,createdAt: 1,authorityEpoch: '1' }
const source = (status?: ConnectionOperationStatus,cancelRequested = false): ConnectionMetadataSnapshot => ({ version: 1,revision: '5',items: [],application: [],verificationProtocol: 2,
  verification: [{ ...record,cancelRequested,...(status ? { status } : {}) }] })
const status = (): ConnectionOperationStatus => ({ version: 1,operationId,scopeKey: 'device:one',resourceKey: null,deviceId: 'one',revision: null,operation: 'save',
  original: { status: 'failed',errorCode: 'CONNECTION_OUTCOME_UNKNOWN',terminal: true },resolution: null,
  effective: { state: 'confirming',connectionState: 'confirming',blocksNewOperations: true },confirmation: { state: 'pending',deadlineAt: null } })
it('shows a pre-publication intent on its application without inventing a resource key or account',() => {
  const snapshot = source()
  expect(connectionApplicationStatus(snapshot,'asana')).toEqual({ key: 'confirmingAuthorization',confirming: true })
  expect(connectionApplicationStatus(snapshot,'github')).toBeUndefined(); expect(snapshot.items).toEqual([])
})
it.each(['connected','notConnected'] as const)('preserves the previous %s state while cancellation is pending and prevents new actions',state => {
  const presentation = connectionApplicationStatus(source(undefined,true),'asana')!
  expect(presentation).toEqual({ key: 'cancelling',confirming: true,preserveState: true })
  expect(withConnectionVerification({ id: 'asana',name: 'Asana',description: '',state,saved: state === 'connected' },presentation,'正在取消'))
    .toMatchObject({ state,connectionStatus: '正在取消',connectionBusy: true,saved: true })
})
it('removes the pending overlay after a real result while retaining the original UNKNOWN receipt',() => {
  for (const outcome of ['applied','failed','cancelled'] as const) {
    const received: ConnectionOperationStatus = { ...status(),resolution: { outcome,resolvedAt: '2026-11-07T00:00:00Z',errorCode: null },
      effective: { state: outcome === 'applied' ? 'succeeded' : outcome,connectionState: outcome === 'applied' ? 'connected' : 'disconnected',blocksNewOperations: false },confirmation: { state: 'resolved',deadlineAt: null,cancelRequested: true } }
    const snapshot = source(received,true)
    expect(connectionApplicationStatus(snapshot,'asana')).toBeUndefined(); expect(snapshot.items).toEqual([])
    expect(snapshot.verification?.[0]?.status?.original.errorCode).toBe('CONNECTION_OUTCOME_UNKNOWN')
  }
})
it('uses the captured pre-window state while cancelling even if metadata changes behind the dialog',() => {
  const snapshot = source(undefined,true)
  snapshot.verification![0]!.previous = { state: 'unverified',saved: true }
  const presentation = connectionApplicationStatus(snapshot,'asana')!
  expect(withConnectionVerification({ id: 'asana',name: 'Asana',description: '',state: 'needsReauth',saved: true },presentation,'正在取消'))
    .toMatchObject({ state: 'unverified',connectionBusy: true,connectionStatus: '正在取消' })
})
it('shows a server-confirmed cancellation request in the same application row after another client requested it',() => {
  const snapshot = source({ ...status(),confirmation: { state: 'pending',deadlineAt: null,cancelRequested: true } })
  expect(connectionApplicationStatus(snapshot,'asana')).toMatchObject({ key: 'cancelling',confirming: true,preserveState: true })
})
it('uses a newer read-only UNKNOWN fact without changing an older pending receipt',() => {
  const snapshot = source()
  snapshot.verification = []
  snapshot.items = [{ owner_user_id: 'owner',domain: 'integrations',device_id: 'one',resource_key: '["device:one","key"]',revision: '1',
    deleted_at: null,data: { providerId: 'asana' },body_item_id: null,body_sha256: null,observed_at: null,updated_at: 'now' }]
  snapshot.application = [{ operationId,domain: 'integrations',scopeKey: 'device:one',resourceKey: '["device:one","key"]',deviceId: 'one',revision: '1',operation: 'save',status: 'pending',errorCode: null,
    verificationOriginal: status().original,effective: status().effective }]
  expect(connectionApplicationStatus(snapshot,'asana')).toEqual({ key: 'authorizationUnknown',confirming: true })
  expect(snapshot.application[0]).toMatchObject({ status: 'pending',errorCode: null })
})
it('does not replace a newer tombstone with historical authorization success or failure',() => {
  const received: ConnectionOperationStatus = { ...status(),resourceKey: 'original-key',revision: '4',resolution: { outcome: 'failed',resolvedAt: '2026-11-07T00:00:00Z',errorCode: null },
    effective: { state: 'failed',connectionState: 'failed',blocksNewOperations: false } }
  const snapshot = source(received)
  snapshot.verification![0]!.resourceKey = 'original-key'
  snapshot.items = [{ owner_user_id: 'owner',domain: 'integrations',device_id: 'one',resource_key: '["device:one","original-key"]',revision: '5',
    deleted_at: 'now',data: { providerId: 'asana' },body_item_id: null,body_sha256: null,observed_at: null,updated_at: 'now' }]
  expect(connectionApplicationStatus(snapshot,'asana')).toBeUndefined(); expect(snapshot.items[0]?.deleted_at).toBe('now')
})
