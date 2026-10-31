/**
 * #3812 —— 会话状态的**唯一写入口**。
 *
 * 权威记录是 `identity.agent_runtime_states`（activity_status 与读数），唯一的写法是
 * RPC `set_agent_runtime_state`。这个模块是那次写的**单一 choke point**：runtime 进程的全部写点
 * （startup sweep / 周期 tick-report / command-wake 触发的 tick）和渲染层
 * 都从这里过。在不在线只看设备行与 desired,这里不再写 runtime_status(后端也不再听它)。
 *
 * ⚠️ 为什么它单独一个文件、而不留在 deviceRuntime.ts 里：渲染层也要走这道门，而 deviceRuntime.ts
 * 依赖 node:child_process / node:fs / node:os，渲染层 import 不进来（会把 node 内建拖进浏览器包）。
 * 写口独立成一个只碰 fetch/Promise 的模块之后，两侧才可能真的用同一份实现 —— 收口不是整理代码，
 * 是把「只有一个写入口」这条不变量变成物理事实。收口前渲染层手写了一份最小 RPC 调用，两边靠
 * 「改一处对照另一处」的注释同步，且渲染层那份**没有** gone-agent 处理（agent 已被删时直接抛错）。
 *
 * ❌ 不许在别处另开写点 —— 新的写点应当调用本模块。
 */

import {
  resolveDeviceOperationTimeouts,
  runDeviceRequest,
  type DeviceOperationTimeoutOverrides,
} from './deviceOperationTimeouts'
import type { AgentActivityStatus } from '../shared/types/chat'
import type { AgentStatus, AgentStatusDetail } from '../shared/agentStatus'

export interface AgentRuntimeStateRpcClient {
  rpc(
    fn: 'set_agent_runtime_state',
    args: Record<string, unknown>
  ): PromiseLike<{ error: { message: string } | null }>
}

/**
 * 一次权威状态写的输入。
 *
 * 比 runtime 侧的 `AgentRuntimeStateReport` 宽：那边是 runtime 进程自己的观测，字段齐全；
 * 这里要同时接住渲染层的收敛写（进程压根没起来、只有界面知道该收敛）。`AgentRuntimeStateReport`
 * 结构上满足本类型，runtime 侧照旧原样传。
 */
export interface AgentRuntimeStateWrite {
  agentUserId: string
  /** 读数的 running/idle 投影(老客户端只读得懂这一维)。 */
  activityStatus: AgentActivityStatus
  /**
   * 这个 agent 在本机的读数(spec agent-status-vocabulary):新客户端读它,别的设备、群里别人因此看到与本机
   * 同一个答案。缺省 = 这次写说不出读数(下线、建 / 停的收敛写)⇒ 云端那两列清空,读方回退 `activity_status`。
   */
  agentStatus?: AgentStatus | null
  agentStatusDetail?: AgentStatusDetail | null
  /**
   * @@@runtime-kind-preserve — 引擎种类 / 主机标签，是 runtime 进程的**本机信息**。runtime 侧必给；
   * 渲染层没有这两样，只能先把权威表里的现值读出来原样传回。故这里放宽成可选 —— 这正是收口的前提，
   * 收口前渲染层就是因为「入口把它们当必填」才另起炉灶手写了 RPC。
   *
   * ⚠️ 放宽 ≠ 可以省。SQL 的 ON CONFLICT 对这两列**不做 COALESCE**（`runtime_kind = EXCLUDED.runtime_kind`，
   * 见 gugu-supabase 的 supabase/migrations/20260926014000_agent_status_reading_on_presence_6448.sql，不同于 runtime_status /
   * recent_actions），所以传 null = 把 runtime 进程写好的值抹成 NULL，不是「保持不变」。
   * 不知道现值的调用方必须先读再传。
   */
  runtimeKind?: string | null
  runtimeLabel?: string | null
  // @@@recent-actions (#518) / @@@last-action-at (#437) —— 两列 SQL 侧都是 COALESCE(EXCLUDED, 现值)，
  // 省略 = 传 NULL = 保留现值，非 runtime 观测方可以放心不给。
  recentActions?: string[] | null
  lastActionAt?: string | null
}

// @@@2151 gone-agent 判定器：agent 在别处删 / 非本 owner 时，set_agent_runtime_state 命中 migration 036
// `can_write_agent_runtime_state` 的 RAISE「not writable by current user」（或「requires an owned agent」）。
export const isAgentRuntimeStateGoneError = (message: string): boolean =>
  /not writable by current user|requires an owned agent/i.test(message)

export interface AgentRuntimeStateReporterHooks {
  /**
   * gone(DB 已删/非本 owner)时:本地 drop 该 agent(以 gugu_user_id = agentUserId 定位),免后续 tick
   * 再写再 churn。守卫收口在此 = 一处覆盖**全部写点**(startup sweep / 周期 tick-report / command-wake
   * 触发的 tick 都经此 reporter)。
   *
   * 没有本地花名册的调用方（渲染层）不传即可：gone 依旧被静默吞掉，不抛给调用方。
   */
  onGoneAgent?: (agentUserId: string) => void | Promise<void>
}

export function createAgentRuntimeStateReporter(
  client: AgentRuntimeStateRpcClient,
  hooks?: AgentRuntimeStateReporterHooks,
  operationTimeouts?: DeviceOperationTimeoutOverrides,
) {
  return async (state: AgentRuntimeStateWrite): Promise<void> => {
    const timeouts = resolveDeviceOperationTimeouts(operationTimeouts)
    const { error } = await runDeviceRequest(
      'agent runtime state write',
      timeouts.runtimeStateWriteMs,
      () => client.rpc('set_agent_runtime_state', {
        p_agent_user_id: state.agentUserId,
        p_activity_status: state.activityStatus,
        // @@@runtime-kind-preserve — 见上：这两列 SQL 不 COALESCE，null 是「抹成 NULL」不是「不变」。
        p_runtime_kind: state.runtimeKind ?? null,
        p_runtime_label: state.runtimeLabel ?? null,
        p_last_seen_at: new Date().toISOString(),
        // @@@recent-actions (#518) - null when this report is a per-event flip / offline; the SQL
        p_recent_actions: state.recentActions ?? null,
        // @@@last-action-at (#437) - the agent's real newest tool-action time.
        // 「这一轮为哪个会话跑」这一维(p_active_chat_id)已删:它让同一个 agent 在不同会话面给出两个答案。
        p_last_action_at: state.lastActionAt ?? null,
        p_agent_status: state.agentStatus ?? null,
        p_agent_status_detail: state.agentStatusDetail ?? null
      }),
    )
    if (!error) return
    // @@@2151 gone-agent 单一 choke point:agent 在别处删/非本 owner → RAISE。良性(该 agent 本就不该有
    // 本机 online 态):本地静默 drop、❌ 不 throw。throw 会让**每一个写点**(sweep / 周期 tick-report /
    // command-wake 触发的 tick / UI 侧创建失败收敛)的调用方 bare-log
    // `[device-runtime] not writable` → 真实用户日志刷屏 + e2e #1679 主进程 guard churn。只有这一类良性
    // gone 走 drop-and-swallow;其余错误(网络/其它权限)照常 throw、由调用方处置
    // (never mass-remove on a blip)。
    if (isAgentRuntimeStateGoneError(error.message)) {
      await hooks?.onGoneAgent?.(state.agentUserId)
      return
    }
    throw new Error(error.message)
  }
}
