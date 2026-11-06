import { describe,expect,it } from 'vitest'
import { connectionApplicationStatus } from '../../apps/desktop/src/components/connections/connection-application-status'
import type { ConnectionMetadataSnapshot } from '../../apps/desktop/src/components/connections/connection-metadata'
const snapshot = (changes: unknown[],items: unknown[] = [{ resource_key: '["device:one","same"]',data: { providerId: 'github' },deleted_at: 'now' }]) =>
  ({ items,application: changes } as ConnectionMetadataSnapshot)
const operation = (extra = {}) => ({ resourceKey: '["device:one","same"]',revision: '9007199254740993',operation: 'save',status: 'pending',...extra })
describe('connection application row state',() => {
  it('keeps a tombstoned pending account on its own application row',() => {
    expect(connectionApplicationStatus(snapshot([operation()]),'github')).toEqual({ key: 'confirmingAuthorization',confirming: true })
    expect(connectionApplicationStatus(snapshot([operation({ operation: 'remove' })]),'github')?.key).toBe('confirmingDisconnect')
  })
  it('never joins a same resource key from another scope or another provider',() => {
    expect(connectionApplicationStatus(snapshot([operation({ resourceKey: '["device:two","same"]' })]),'github')).toBeUndefined()
    expect(connectionApplicationStatus(snapshot([operation()]),'feishu')).toBeUndefined()
  })
  it('keeps unknown outcomes under confirmation without making them executable',() => {
    expect(connectionApplicationStatus(snapshot([operation({ status: 'failed',terminal: true,errorCode: 'CONNECTION_OUTCOME_UNKNOWN' })]),'github'))
      .toEqual({ key: 'authorizationUnknown',confirming: true })
  })
  it('updates an application from a read adapter receipt without rewriting the original unknown record',() => {
    const unknown = operation({ status: 'failed',terminal: true,errorCode: 'CONNECTION_OUTCOME_UNKNOWN' })
    const saved = snapshot([unknown])
    const received = snapshot([operation({ status: 'failed',terminal: true,errorCode: 'AUTHORIZATION_FAILED' })]).application
    expect(connectionApplicationStatus(saved,'github',received)).toEqual({ key: 'authorizationFailed',confirming: false })
    expect(saved.application[0]?.errorCode).toBe('CONNECTION_OUTCOME_UNKNOWN')
  })
  it('replaces an older failed state with a newer pending operation using bigint revisions',() => {
    expect(connectionApplicationStatus(snapshot([operation({ status: 'failed' }),operation({ revision: '9007199254740994',operation: 'remove' })]),'github')?.key).toBe('confirmingDisconnect')
    expect(connectionApplicationStatus(snapshot([]),'github')).toBeUndefined()
  })
})
