import { panelIntegrationChecks } from './assistant-panel-integration-checks'
import { eq } from 'drizzle-orm'
import { db } from '@main/db/client'
import { workspaces as workspaceTable } from '@main/db/schema'
import { getSessions } from '@main/core/sessions/getSessions'
import { listSessionStates } from '@main/core/session-timeline/service'
import { listSessionSchedules } from '@main/core/automations/repo'
import { automationsService } from '@main/core/automations/automations-service'
import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance'
import { integrationPluginRegistry } from '@gugu/session-plugins/integrations'
import { buildIntegrationListPayload } from '@main/core/integrations/integration-payload-builder'
import { listAgents } from '@gugu/core'
import { agentMayBelongTo } from '@gugu/core/local/state/agentOwner'
import type { AssistantPanelChange } from '@gugu/core/cloud/assistantPanel'
import { readUserLibraryVolume, readUserLibraryEntry, writeUserLibraryEntry, removeUserLibraryEntry } from './user-library'

/** This bridge lives in the embedded module, beside the actual registries and
 * scheduler. The Electron host must not construct a second copy of either. */
export const assistantPanelLocal = {
  async home(sessionId: string) {
    const row = (await getSessions()).find(row => row.id === sessionId && !row.archivedAt)
    if (!row?.workspaceId) throw new Error('PANEL_SESSION_HOME_UNAVAILABLE')
    const [workspace] = await db.select({ path: workspaceTable.path }).from(workspaceTable).where(eq(workspaceTable.id,row.workspaceId)).limit(1)
    if (!workspace?.path) throw new Error('PANEL_SESSION_HOME_UNAVAILABLE')
    return { cwd: workspace.path,projectId: row.projectId }
  },
  async sessions(ownerId: string) {
    const agents = await listAgents(process.env,{ includeGuests: true })
    const identities = new Map(agents.filter(agent => agentMayBelongTo(agent,ownerId)).map(agent =>
      [agent.cache?.emdash_session_id,agent.gugu_user_id]))
    return listSessionStates().sessions.map(summary => ({ summary,agentId: identities.get(summary.conversationId) ?? null }))
  },
  async schedules(sessionIds: readonly string[]) {
    const summaries = new Map(listSessionSchedules().map(row => [row.id,row]))
    return (await automationsService.listAutomations()).filter(row => row.agentSessionId && sessionIds.includes(row.agentSessionId))
      .map(row => {
        const summary = summaries.get(row.id), last = summary?.lastRun
        return { ...row,nextRunAt: summary?.nextRunAt ?? null,
          lastRun: last ? { status: last.status,at: last.at,errorCode: last.error?.code ?? null } : null }
      })
  },
  async library(kind: 'capabilities' | 'devices') {
    const volume = await readUserLibraryVolume(kind)
    return Promise.all(volume.items.map(item => readUserLibraryEntry(kind,item.id)))
  },
  async integrations(ownerId: string) {
    return (await Promise.all(integrationPluginRegistry.getAll().map(async plugin => {
      const providerId = plugin.metadata.id
      const accounts = await providerAccountRegistry.listAccounts(providerId)
      const verified = accounts.length ? await panelIntegrationChecks(providerId,JSON.stringify(accounts.map(account => [account.accountId,account.updatedAt])),ownerId) : null
      return accounts.map(account => ({
        checkResult: verified?.checks.find(check => check.accountId === account.accountId)?.connected ? 'ok'
          : verified?.checks.find(check => check.accountId === account.accountId)?.errorType === 'authorization_expired' ? 'reauth' : 'failed',
        checkedAt: verified?.checkedAt ?? Date.now(),
        providerId,accountId: account.accountId,configured: true,isDefault: account.isDefault,
        displayName: account.meta?.displayName ?? account.meta?.login ?? account.accountId,
        publicMetadata: { version: 1,providerId,accountId: account.accountId,isDefault: account.isDefault,
          connectedAt: account.createdAt,updatedAt: account.updatedAt,host: account.meta?.host,login: account.meta?.login,
          avatarUrl: account.meta?.avatarUrl,credentialSource: account.meta?.credentialSource,displayName: account.meta?.displayName,
        },
      }))
    }))).flat()
  },
  integrationCatalog() {
    const en = buildIntegrationListPayload('en-US'), zh = buildIntegrationListPayload('zh-CN')
    return en.map(item => ({ id: item.id,en: item,zh: zh.find(row => row.id === item.id)! }))
  },
  async apply(change: AssistantPanelChange, body: Uint8Array | null, sessionIds: readonly string[], ownerId: string) {
    const removed = change.operation === 'remove'
    const data = (change.payload[removed ? 'before' : 'data'] ?? {}) as Record<string, unknown>
    if (change.domain === 'capabilities' || change.domain === 'device-notes') {
      const kind = change.domain === 'capabilities' ? 'capabilities' : 'devices'
      if (removed) return removeUserLibraryEntry(kind,change.resource_key,ownerId)
      const current = await readUserLibraryEntry(kind,change.resource_key).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!body || typeof data.name !== 'string' || typeof data.description !== 'string') throw new Error('PANEL_LIBRARY_DATA_INVALID')
      const content = new TextDecoder('utf-8',{ fatal: true }).decode(body)
      if (current && current.content === content && current.name === data.name && current.description === data.description && current.group === (data.group ?? null)) return
      await writeUserLibraryEntry({ kind,id: change.resource_key,name: data.name,description: data.description,
        group: typeof data.group === 'string' ? data.group : null,content,
        ...(current ? { expectedModifiedAt: current.modifiedAt } : {}),
      },undefined,'ui',ownerId)
      return
    }
    if (change.domain === 'schedules') {
      const current = (await automationsService.listAutomations()).find(row => row.id === change.resource_key)
      if (!current) {
        if (removed) return
        throw new Error('PANEL_RESOURCE_REMOVED')
      }
      if (!current?.agentSessionId || !sessionIds.includes(current.agentSessionId)) throw new Error('PANEL_SCHEDULE_NOT_OWNED')
      if (removed) return automationsService.deleteAutomation(current.id)
      if (change.operation === 'enable' || change.operation === 'disable') {
        const enabled = change.operation === 'enable'
        if (current.enabled !== enabled) await automationsService.setAutomationEnabled(current.id,enabled)
        return
      }
      if (typeof data.title !== 'string' || typeof data.prompt !== 'string' || !current.agentConfig) throw new Error('PANEL_SCHEDULE_DATA_INVALID')
      const triggerConfig = { expr: typeof data.cron === 'string' ? data.cron : '',
        ...(typeof data.tz === 'string' ? { tz: data.tz } : {}),
        ...(typeof data.at === 'number' ? { at: data.at } : {}),
      }
      if (current.name !== data.title) await automationsService.renameAutomation(current.id,data.title)
      if (JSON.stringify(current.triggerConfig) !== JSON.stringify(triggerConfig) || current.agentConfig.prompt !== data.prompt) {
        await automationsService.updateAutomationSettings(current.id,{ triggerConfig,agentConfig: { ...current.agentConfig,prompt: data.prompt } })
      }
      if (typeof data.enabled === 'boolean' && current.enabled !== data.enabled) await automationsService.setAutomationEnabled(current.id,data.enabled)
      return
    }
    if (change.domain === 'integrations') {
      if (typeof data.providerId !== 'string' || typeof data.accountId !== 'string') throw new Error('PANEL_INTEGRATION_DATA_INVALID')
      if (removed) { await providerAccountRegistry.removeAccount(data.providerId,data.accountId); return }
      if (data.isDefault === true) { await providerAccountRegistry.setDefaultAccount(data.providerId,data.accountId); return }
    }
    throw new Error('PANEL_OPERATION_UNSUPPORTED')
  },
}
