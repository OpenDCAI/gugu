import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { SettingsGroup,SettingsNote,SettingsRow } from '@/components/settings/SettingsPrimitives'
import { connectionBridge } from '@/lib/connectionBridge'
import type { ConnectionMetadataSnapshot,ConnectionMetadataStore } from './connection-metadata'
import { connectionFailure } from './connection-copy'

/** Original operation identities remain separate across owner and scope. */
export function ConnectionOperations({ operations,store }: { operations: ConnectionMetadataSnapshot['application']; store?: ConnectionMetadataStore }) {
  const { t } = useTranslation('connections')
  const [busy,setBusy] = useState<string | null>(null),[error,setError] = useState<unknown>(null)
  if (!operations.length || !store) return null
  return <SettingsGroup title={t('operations')} data-testid="connection-operations">
    {operations.map(operation => {
      const row = store.peekSnapshot?.()?.items.find(row => row.resource_key === operation.resourceKey)
      const started = (operation as typeof operation & { wireStatus?: string }).wireStatus === 'started'
      const unknown = operation.errorCode === 'CONNECTION_OUTCOME_UNKNOWN'
      return <SettingsRow key={JSON.stringify([store.ownerId,operation.resourceKey,operation.operationId])} title={t('operation')}
        description={t(unknown ? 'unknown' : started ? 'started' : operation.status === 'failed' ? 'failed' : 'pending')}
        control={row?.source?.scopeKey === 'platform' && !operation.terminal && !unknown ?
          <Button size="sm" disabled={busy !== null} onClick={async () => {
            setBusy(operation.operationId); setError(null)
            try { await connectionBridge().retryOperation(operation.operationId) }
            catch (cause) { setError(cause) }
            finally { setBusy(null); store.invalidate() }
          }}>{t('retry')}</Button> : undefined} />
    })}
    {error ? <SettingsNote role="alert" tone="danger">{connectionFailure(error,t)}</SettingsNote> : null}
  </SettingsGroup>
}
