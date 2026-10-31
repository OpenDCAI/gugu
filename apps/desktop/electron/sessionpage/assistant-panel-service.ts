import { randomUUID } from 'node:crypto'
import type { AssistantPanelChange, AssistantPanelClient } from '@gugu/core/cloud/assistantPanel'

/** A schedule can be deleted locally before an offline panel edit arrives.
 * Reconcile that fact with a newer owner intent, so an impossible edit cannot
 * hold every later turn. Existing schedules with different owners are refused. */
export async function applyAssistantPanelService(change: AssistantPanelChange, apply: () => Promise<void>, cloud: Pick<AssistantPanelClient, 'commit'>): Promise<void> {
  try { await apply() } catch (error) {
    if (change.domain !== 'schedules' || !(error instanceof Error) || error.message !== 'PANEL_RESOURCE_REMOVED') throw error
    await cloud.commit(change.assistant_user_id,{ operationId: randomUUID(),domain: 'schedules',key: change.resource_key,
      expectedRevision: change.revision,operation: 'remove',data: {},deviceId: change.device_id ?? undefined })
    throw new Error('PANEL_RESOURCE_SUPERSEDED')
  }
}
