import { EMPTY_INTEGRATION_SUMMARIES,useAssistantIntegrationSummaries } from '@/components/assistant/useAssistantIntegrationSummaries'
import { useLocale } from '@/i18n'
import { splitInstructions, splitPersona } from '@/session/renderer/features/assistant/assistant-files'
import { readText } from '@/session/renderer/features/assistant/assistant-machine-core'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import type { ConnectionStatus } from '@/session/shared/issue-providers'
import { cachedAssistantPanelIntegration,readAssistantPanelIntegrations,readAssistantPanelIntegration } from '@/components/assistant/assistant-panel-integrations'
import { machineKey, usePhoneRead } from './usePhoneRead'
import type { PhoneMachineState } from './phoneMachine'
import type { Persona } from './phoneProfileModel'


export type PhonePersona = {
  /** 读到的性格;还没读到(在休息、正在醒、读失败)= null。 */
  persona: Persona | null
  revision?: string
  loading: boolean
  error: unknown
  /** 重读(读失败时的「重试」、保存之后核一遍写进去的)。 */
  reload: () => void
}

/**
 * 性格 = 它家里 ~/.claude/CLAUDE.md 里宿主维护那段之外的部分(与桌面 usePersona 同一份解析)。醒着、工作区开好了才读;❌ 自己叫醒。
 * 重读时先留着上一次读到的(资料页胶囊不闪成「性格」)。
 */
export function usePhonePersona(machine: PhoneMachineState): PhonePersona {
  const ready = machine.state === 'ready' ? machine.machine : null
  const read = usePhoneRead(ready ? `persona|${machineKey(ready)}` : null,async () => {
    const raw = await readText(ready!,ready!.paths.instructions)
    return { persona: splitPersona(splitInstructions(raw ?? '').user),revision: ready!.panel?.revision(ready!.paths.instructions) }
  },'read assistant personality')
  return { persona: read.state === 'ok' ? read.data.persona : null,
    revision: read.state === 'ok' ? read.data.revision : undefined,
    loading: !!ready && read.state === 'loading',
    error: read.state === 'error' ? read.error : read.state === 'ok' ? read.refreshError ?? null : null,reload: read.reload }

}

export type PhoneIntegrations = {
  items: IntegrationMetadata[]
  /** 存没存着凭据(不联网):连没连就按它。 */
  configured: Partial<Record<string, boolean>>
  /** 每一家连上的账号(联网问,慢):还没问到 / 问不到 = null,只是少写账号名。 */
  statuses: Partial<Record<string, ConnectionStatus>> | null
  statusError?: unknown
}

/**
 * 云端连接应用:问它家里那台(与桌面资源库「集成」同一组动词 integrations.*,手机走 machineRpc 那条线)。
 * 醒着、且人在连接应用那几页(`active`)才问;每次走进来重问一遍(人可能刚在电脑上连好),重问时先留着上一次的。
 */
export function usePhoneIntegrations(machine: PhoneMachineState, active: boolean): { data: PhoneIntegrations | null; loading: boolean; error: unknown; retry: () => void } {
  const { resolvedLocale } = useLocale()
  const ready = machine.state === 'ready' ? machine.machine : null
  const read = usePhoneRead(active && ready ? `integrations|${machineKey(ready)}|${resolvedLocale}` : null,
    () => readAssistantPanelIntegrations(ready!.panel!,resolvedLocale),'read assistant integration metadata')
  const items = useAssistantIntegrationSummaries(ready?.panel,read.state === 'ok' ? read.data.items : EMPTY_INTEGRATION_SUMMARIES,resolvedLocale)
  return { data: read.state === 'ok' ? { ...read.data,items } : null,loading: read.state === 'loading',error: read.state === 'error' ? read.error : null,retry: read.reload }
}

export function usePhoneIntegrationDetail(machine: PhoneMachineState,summary: IntegrationMetadata | null | undefined) {
  const { resolvedLocale } = useLocale()
  const panel = machine.state === 'ready' ? machine.machine.panel : undefined
  const cached = cachedAssistantPanelIntegration(panel,summary?.id,resolvedLocale,summary?.catalogVersion)
  const read = usePhoneRead(panel && summary?.metadataOnly && !cached ? `integration-detail|${panel.ownerId}|${panel.assistantId}|${summary.id}|${summary.catalogVersion ?? ''}|${resolvedLocale}` : null,
    () => readAssistantPanelIntegration(panel!,summary!.id,resolvedLocale,summary?.catalogVersion),'read selected application')
  return { data: summary?.metadataOnly ? cached ?? (read.state === 'ok' ? read.data : null) : summary,
    error: !cached && summary?.metadataOnly && read.state === 'error' ? read.error : null,
    loading: summary?.metadataOnly === true && !cached && read.state === 'loading',reload: read.reload }
}
