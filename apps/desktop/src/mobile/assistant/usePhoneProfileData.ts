import { useCallback, useEffect, useState } from 'react'
import { useLocale } from '@/i18n'
import { rendererLogger } from '@/lib/log'
import { splitInstructions, splitPersona } from '@/session/renderer/features/assistant/assistant-files'
import { readText } from '@/session/renderer/features/assistant/assistant-machine-core'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import type { ConnectionStatus } from '@/session/shared/issue-providers'
import { machineRpc } from '../agent-watch/sessionpage-rpc'
import type { PhoneMachineState, PhoneReadiness } from './phoneMachine'
import type { Persona } from './phoneProfileModel'

const log = rendererLogger('mobile/assistant')

export type PhonePersona = {
  /** 读到的性格;还没读到(在休息、正在醒、读失败)= null。 */
  persona: Persona | null
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
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<{ key: unknown; attempt: number; persona?: Persona; error?: unknown } | null>(null)
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    readText(ready, ready.paths.instructions).then(
      (raw) => {
        if (!cancelled) setRead({ key: ready, attempt, persona: splitPersona(splitInstructions(raw ?? '').user) })
      },
      (error: unknown) => {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, 'read assistant persona failed')
        if (!cancelled) setRead({ key: ready, attempt, error })
      },
    )
    return () => {
      cancelled = true
    }
  }, [ready, attempt])
  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  const sameMachine = !!ready && read?.key === ready
  const fresh = sameMachine && read?.attempt === attempt
  return {
    persona: sameMachine ? read?.persona ?? null : null,
    loading: !!ready && !fresh,
    error: fresh ? read?.error ?? null : null,
    reload,
  }
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
export function usePhoneIntegrations(
  homeDeviceId: string | null,
  readiness: PhoneReadiness,
  active: boolean,
): { data: PhoneIntegrations | null; loading: boolean; error: unknown; retry: () => void } {
  const { resolvedLocale } = useLocale()
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<{ key: string; data?: PhoneIntegrations; error?: unknown } | null>(null)
  const device = readiness === 'ready' ? homeDeviceId : null
  const key = `${device}|${resolvedLocale}|${attempt}`
  useEffect(() => {
    if (!active || !device) return
    let cancelled = false
    const integrations = machineRpc(device).integrations
    void (async () => {
      try {
        const [items, configured] = await Promise.all([integrations.list(resolvedLocale), integrations.checkConfiguredConnections()])
        if (cancelled) return
        setRead({ key, data: { items, configured, statuses: null } })
        // 账号名要每一家联网查一次,慢:列表先出来,查到了再补上。查不到只是不写账号名(连没连上已按凭据说了)。
        try {
          const statuses = await integrations.checkAllConnections()
          if (!cancelled) setRead({ key, data: { items, configured, statuses } })
        } catch (error) {
          log.warn({ error: error instanceof Error ? error.message : String(error) }, 'check assistant connector statuses failed')
          if (!cancelled) setRead({ key, data: { items, configured, statuses: null, statusError: error } })
        }
      } catch (error) {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, 'list assistant connectors failed')
        if (!cancelled) setRead({ key, error })
      }
    })()
    return () => {
      cancelled = true
    }
    // key 已含 device / 语言 / 第几次;active 由关到开 = 人又走进来,重问一遍。
  }, [active, device, resolvedLocale, key])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const fresh = read?.key === key
  return {
    data: read?.data ?? null,
    loading: !!device && !fresh,
    error: fresh ? read?.error ?? null : null,
    retry,
  }
}
