/**
 * Agent 级模型选择的**云端**读写（#5276）—— 桌面与手机同一条路，不经 Electron IPC。
 *
 * 之前这份选择只存在跑 Agent 的那台桌面机本地，读写只有 `agent-model:get/set` 两条 IPC；
 * 手机、Web、另一台同账号的 gugu 机器既读不到也改不了。现在：
 *   - 目录：edge function `model-access` 的 `catalog`（用户 token 即可，谁都能问）；
 *   - 当前值：`identity.agent_model_selections`（desired = 用户要的，applied = 设备真落下的）；
 *   - 写：RPC `set_agent_model_selection` 写 desired 并向绑定设备投 `agent.set_model`，
 *     调用方等这条命令落终态 —— 命令的 done/error 就是「设备落没落下、为什么没落下」。
 *
 * ❌ 不在这里把「写进云里了」翻译成「已生效」：applied 与 desired 分开返回，界面自己决定怎么说。
 */
import {
  engineIdForAgentType,
  isModelAccessProtocol,
  normalizeAgentModelSelection,
  type AgentModelSelection,
  type ModelAccessProtocol,
} from '@gugu/core/shared/agentModelSelection'
import type { AgentType } from '@gugu/core/agentTypes'
import { platformWireProtocol } from '@gugu/session-plugins/agents/platform-protocols'
import { edgeFunctionError } from './edgeFunctionError'
import { identityDb, dataClient } from './supabase'
import { PLATFORM_MODELS_CHANGED_EVENT } from '@/session/shared/core/agents/platform-model'
import { chatService } from './chat'
import type { SessionpageSessionCreateModels } from '@gugu/session-core/session-record/contract'
import { rpcOn } from '@/session/renderer/lib/ipc'
import { platformModelsEnabled } from '@gugu/core/cloud/optionalServices'
import { fetchCreateModels } from '@/mobile/agent-watch/sessionpage-rpc'

export interface PlatformCatalogModel {
  id: string
  displayName: string
  protocols: ModelAccessProtocol[]
  enabled: boolean
  /** 目录 `requires_membership`(#7056):这一档(免费档)用不了、要开会员。只认 true,旧服务端不带 ⇒ false。 */
  requiresMembership: boolean
  /** 目录 `hidden`(#7056):他在设置「模型」页关掉了这一条。只认 true,旧服务端不带 ⇒ false。 */
  hidden: boolean
  creditMultiplier?: number | null
  contextWindow?: number | null
}

export interface AgentModelSelectionState {
  desired: AgentModelSelection
  applied: AgentModelSelection | null
  appliedAt: string | null
  applyError: string | null
}

/** 这个 agent_type 的引擎说哪条协议；说不了平台协议（云 agent、未登记的 harness）= null。 */
export function platformProtocolForAgentType(agentType: AgentType | null | undefined): ModelAccessProtocol | null {
  if (!agentType) return null
  const engineId = engineIdForAgentType(agentType)
  return engineId ? platformWireProtocol(engineId) : null
}

/** 调一次 `model-access`;失败时把服务端那句原话(`{ error }`)抛出来,拿不到原话才用传输层的。 */
async function invokeModelAccess(body: Record<string, unknown>): Promise<unknown> {
  if (!platformModelsEnabled()) throw new Error('Official model service is not configured')
  const { data, error } = await dataClient.functions.invoke('model-access', { body })
  if (error) throw new Error(await edgeFunctionError(error))
  return data
}

export async function fetchPlatformModelCatalog(): Promise<PlatformCatalogModel[]> {
  if (!platformModelsEnabled()) return []
  const data = await invokeModelAccess({ action: 'catalog' })
  const models = (data as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) throw new Error('model catalog response is malformed')
  return models.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    const displayName = typeof row.display_name === 'string' ? row.display_name.trim() : ''
    const protocols = Array.isArray(row.protocols) ? row.protocols.filter(isModelAccessProtocol) : []
    return id && displayName && protocols.length > 0
      ? [{
          id,
          displayName,
          protocols,
          enabled: row.enabled === true,
          requiresMembership: row.requires_membership === true,
          hidden: row.hidden === true,
          creditMultiplier: typeof row.credit_multiplier === 'number' ? row.credit_multiplier : null,
          contextWindow: typeof row.context_window === 'number' ? row.context_window : null,
        }]
      : []
  })
}

/**
 * 设置「模型」页的开关(#7056):关掉 = 不出现在他的模型下拉里(所有设备,跟着账号走)。
 * 存哪一格由 `model-access` 管,客户端 ❌ 自己写 user_settings。写完通知同一窗口里的下拉重取目录。
 */
export function setPlatformModelHidden(modelId: string, hidden: boolean): Promise<void> {
  // 一个接一个发:连拨同一个开关两下,两次请求要按拨的顺序落库,❌ 后拨的先到、库里停在反的那一边。
  const run = visibilityWrites.then(async () => {
    await invokeModelAccess({ action: 'set_model_hidden', model_id: modelId, hidden })
    window.dispatchEvent(new Event(PLATFORM_MODELS_CHANGED_EVENT))
  })
  visibilityWrites = run.catch(() => undefined)
  return run
}
let visibilityWrites: Promise<void> = Promise.resolve()

export async function readAgentModelSelection(agentUserId: string): Promise<AgentModelSelectionState> {
  const { data, error } = await identityDb
    .from('agent_model_selections')
    .select('desired, applied, applied_at, apply_error')
    .eq('agent_user_id', agentUserId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const row = data as { desired: unknown; applied: unknown; applied_at: unknown; apply_error: unknown } | null
  if (!row) {
    // 从没设过 = 沿用 Agent 自己的配置。这不是「读不到」，是明确的默认态。
    return { desired: { source: 'default' }, applied: null, appliedAt: null, applyError: null }
  }
  return {
    desired: normalizeAgentModelSelection(row.desired),
    applied: row.applied == null ? null : normalizeAgentModelSelection(row.applied),
    appliedAt: typeof row.applied_at === 'string' ? row.applied_at : null,
    applyError: typeof row.apply_error === 'string' && row.apply_error ? row.apply_error : null,
  }
}

export type AgentModelSelectionOutcome =
  | {
      ok: true
      applied: 'hot' | 'reload' | 'next-session'
      /** #6247 重开后 harness 原生会话的去向;`null` = 设备没说(旧设备不带这一格),界面给中性文案。 */
      nativeSession: 'preserved' | 'replaced' | null
      warning: string | null
    }
  | { ok: false; error: string }

/**
 * 写 desired 并等设备把它落下。等到终态才返回：done 带设备的结局（当场热切 / 重开续上 / 下次会话生效），
 * error 带设备的原话。超时（设备不在线、命令没人认领）也是 error —— 那时 desired 已在云里，
 * 设备上线后会执行，界面据 `readAgentModelSelection` 的 desired ≠ applied 显示「待设备生效」。
 */
export async function setAgentModelSelection(
  agentUserId: string,
  selection: AgentModelSelection,
  options: { timeoutMs?: number } = {},
): Promise<AgentModelSelectionOutcome> {
  const { data, error } = await identityDb.rpc('set_agent_model_selection', {
    p_agent_user_id: agentUserId,
    p_selection: selection,
  })
  if (error) throw new Error(error.message)
  const commandId = typeof data === 'string' ? data : null
  if (!commandId) throw new Error('set_agent_model_selection returned no command id')
  // pollDeviceCommandUntilDone：done → 返回；error → throw 设备原话；超时 → throw 'Device command timed out'。
  // 两种 throw 都是「没落下」，都要如实带回；❌ 不把超时吞成成功（desired 已在云里，但设备还没动）。
  let command: Awaited<ReturnType<typeof chatService.waitForDeviceCommand>>
  try {
    command = await chatService.waitForDeviceCommand(commandId, options.timeoutMs ?? 60_000)
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
  const result = (command.result ?? {}) as { applied?: unknown; nativeSession?: unknown; warning?: unknown }
  const applied = result.applied === 'hot' || result.applied === 'reload' || result.applied === 'next-session'
    ? result.applied
    : 'next-session'
  return {
    ok: true,
    applied,
    nativeSession: result.nativeSession === 'preserved' || result.nativeSession === 'replaced'
      ? result.nativeSession
      : null,
    warning: typeof result.warning === 'string' && result.warning ? result.warning : null,
  }
}

/** 目录与订阅凭据都问 Agent 实际所在设备；控制端本机账号不能冒充远端凭据。 */
export async function fetchAgentHarnessModels(deviceId: string, harness: string, isLocal: boolean): Promise<SessionpageSessionCreateModels> {
  if (!isLocal) return fetchCreateModels(deviceId, harness, 'general', null)
  const result = await rpcOn(null).sessionTimeline.sessionCreateModels({ harness, sessionView: 'general' })
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
