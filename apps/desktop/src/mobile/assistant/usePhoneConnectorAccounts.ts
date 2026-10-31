import {assistantPanelCollection,type AssistantPanelItem} from '@gugu/core/cloud/assistantPanel'
import type { AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'
import { machineKey, usePhoneRead } from './usePhoneRead'
import { assistantAccountDisplayName } from '@/components/assistant/assistant-app-connections'

export type ConnectorAccountRow = { accountId: string; label: string; connectedAt: number | null }
export type PhoneConnectorAccounts = { accounts: ConnectorAccountRow[] | null; supported: boolean; error: unknown; reload(): void }

/** Saved account labels only; no credential lookup or network verification. */
export function usePhoneConnectorAccounts({ machine,id,name,enabled,refreshKey }: {
  machine: AssistantMachine | null; device: string | null; id: string; name: string; enabled: boolean; refreshKey: number
}): PhoneConnectorAccounts {
  const parse = (rows: AssistantPanelItem[]) => rows.filter(row => row.data.providerId === id && typeof row.data.accountId === 'string').map(row => ({
    accountId: row.data.accountId as string,label: assistantAccountDisplayName(row.data.displayName) ?? name,connectedAt: null,
  }))
  const initial = () => {
    const snapshot = machine?.panel?.peekSnapshot?.()
    return snapshot ? parse(assistantPanelCollection(snapshot,'integrations',machine?.panel?.deviceId).items) : undefined
  }
  const read = usePhoneRead(enabled && machine ? `integration-accounts|${machineKey(machine)}|${id}|${refreshKey}` : null,async () => {
    const rows = await machine!.panel!.collection('integrations')
    return parse(rows)
  },'read saved integration accounts',undefined,initial)
  return { accounts: read.state === 'ok' ? read.data : null,supported: true,error: read.state === 'error' ? read.error : null,reload: read.reload }
}
