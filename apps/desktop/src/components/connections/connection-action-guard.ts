import { ConnectionError,type ConnectionClient } from '@gugu/core/cloud/connections'

/** Check the latest owner data, including callbacks retained by an old dialog. */
export async function assertConnectionApplicationAvailable(input: {
  ownerId: string; accountId(): string | null; client: Pick<ConnectionClient,'snapshot'>
  provider: string; scopeKey: string; requireReady?: boolean; operationIds?: readonly string[]; changed(): void
}) {
  const current = () => {
    if (input.accountId() !== input.ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED')
  }
  current()
  const snapshot = await input.client.snapshot()
  current()
  for (const operation of snapshot.application ?? []) {
    if (operation.scopeKey !== input.scopeKey) continue
    if (operation.errorCode !== 'CONNECTION_OUTCOME_UNKNOWN' && !['pending','started'].includes(operation.status)) continue
    const item = snapshot.items?.find(item => item.scopeKey === operation.scopeKey && item.resourceKey === operation.resourceKey)
    if (!item) throw new ConnectionError('invalid-response','CONNECTION_OPERATION_RESOURCE_MISSING')
    if (item.data.providerId !== input.provider) continue
    if (operation.errorCode !== 'CONNECTION_OUTCOME_UNKNOWN' && input.operationIds?.includes(operation.operationId)) continue
    input.changed()
    throw new ConnectionError(operation.errorCode === 'CONNECTION_OUTCOME_UNKNOWN' ? 'outcome-unknown' : 'operation-pending','CONNECTION_APPLICATION_BUSY')
  }
  // recreate_begin initializes a genuinely new owner; effects still require a
  // subsequent explicitly ready snapshot. A read error never authorizes work.
  if (input.requireReady && snapshot.state !== 'ready') throw new ConnectionError('not-ready','CONNECTION_NOT_READY')
}
