import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { Automation } from '@/session/shared/core/automations/automation'

export type PanelRoutine = Automation & { panelRevision: string; nextRunAt: number | null }
export function assistantPanelRoutines(panel: AssistantPanelFiles) {
  async function items() { return panel.collection('schedules') }
  return {
    async list(): Promise<PanelRoutine[]> {
      return (await items()).map(row => ({
        id: row.resource_key,name: String(row.data.title ?? ''),enabled: row.data.enabled === true,
        triggerConfig: { expr: typeof row.data.cron === 'string' ? row.data.cron : '',
          ...(typeof row.data.at === 'number' ? { at: row.data.at } : {}),...(typeof row.data.tz === 'string' ? { tz: row.data.tz } : {}),
        },agentConfig: { prompt: String(row.data.prompt ?? ''),provider: 'claude',autoApprove: true },
        agentSessionId: panel.assistantId,createdAt: Date.parse(row.updated_at),updatedAt: Date.parse(row.updated_at),panelRevision: row.revision,
        nextRunAt: typeof row.data.nextRunAt === 'number' ? row.data.nextRunAt : typeof row.data.nextRunAt === 'string' ? Date.parse(row.data.nextRunAt) : null,
      }))
    },
    async setEnabled(id: string, enabled: boolean, expectedRevision?: string) {
      const item = (await items()).find(row => row.resource_key === id)
      if (!item || expectedRevision && expectedRevision !== item.revision) throw new AssistantPanelError('PT409','PANEL_RESOURCE_CHANGED')
      await panel.change(item,enabled ? 'enable' : 'disable')
    },
    async remove(id: string, expectedRevision?: string) {
      const item = (await items()).find(row => row.resource_key === id)
      if (!item) return
      if (expectedRevision && item.revision !== expectedRevision) throw new AssistantPanelError('PT409','PANEL_RESOURCE_CHANGED')
      await panel.change(item,'remove')
    },
    async next(id: string) {
      const row = (await this.list()).find(row => row.id === id)
      return row?.nextRunAt == null ? null : { scheduledAt: row.nextRunAt }
    },
  }
}
