// #987 Agent 定时任务 — 调度运行时（纯逻辑 + gateway 接口）。
//
// 触发不在 DB（无 pg_cron）：Electron 设备运行时按「最早到期时刻」调用 runDueScheduledTasks（到点才扫，
// 见 deviceRuntimeHost 的定时任务驱动），按 owner RLS 查启用任务，挑到期的，复用既有 ACP deliver 链路
// （gugu_device_commands 的 agent.deliver）
// 投递到 owner↔agent 私聊。此模块只含**纯逻辑 + 一个可注入 gateway 接口**（supabase 适配器在 electron 层
// 用全量 client 实现），便于单测且与具体 client 解耦。

import type { AgentDeliverDeviceCommandInput } from './deviceCommands'

export interface AgentScheduledTaskRow {
  id: string
  agent_user_id: string
  owner_user_id: string
  chat_id: string
  title: string | null
  prompt: string
  schedule_kind: 'interval'
  interval_seconds: number | null
  enabled: boolean
  next_run_at: string | null
  last_run_at: string | null
  created_at: string
  updated_at: string
}

// ── 纯逻辑 ──────────────────────────────────────────────────────────────────────

/** 下次触发 = 基准时刻 + interval。返回 ISO 串。 */
export function computeNextRunAt(intervalSeconds: number, fromMs: number): string {
  return new Date(fromMs + intervalSeconds * 1000).toISOString()
}

/** 到期 = 已启用 + 有 next_run_at + next_run_at <= now。无 next_run_at（未排期）视为不到期。 */
export function isTaskDue(
  task: Pick<AgentScheduledTaskRow, 'enabled' | 'next_run_at'>,
  nowMs: number,
): boolean {
  if (!task.enabled) return false
  if (!task.next_run_at) return false
  const t = Date.parse(task.next_run_at)
  return Number.isFinite(t) && t <= nowMs
}

export function selectDueTasks(tasks: readonly AgentScheduledTaskRow[], nowMs: number): AgentScheduledTaskRow[] {
  return tasks.filter((task) => isTaskDue(task, nowMs))
}

// ── 运行 ────────────────────────────────────────────────────────────────────────

/** 调度器需要的最小能力面；supabase 适配器（electron 层）按此实现，单测用 mock。 */
export interface AgentScheduledTaskGateway {
  /** 本 owner 的全部「启用」任务（RLS 已限定 owner；调度器再按时间挑到期）。 */
  listEnabledTasks(ownerUserId: string): Promise<AgentScheduledTaskRow[]>
  /** agent 当前所在设备 id（触发时实时查，不存任务行上——防 agent 迁移后投递落到旧设备）。 */
  resolveAgentDeviceId(agentUserId: string): Promise<string | null>
  /** 复用既有 agent.deliver 设备命令链路（→ handleAgentDeliverDeviceCommand → ACP session.prompt）。 */
  enqueueAgentDeliver(input: AgentDeliverDeviceCommandInput): Promise<string>
  /**
   * 推进排期：写 next_run_at（interval 推进 / 一次性置 null）+ last_run_at。**CAS**:只在这一行的 next_run_at 仍是
   * `expectedNextRunAt` 时才写,返回写没写成。
   *
   * 同一个 owner 的每台在线设备都在同一个到期时刻醒来(到点定时器挂的是同一个时刻)⇒ 没有这道 CAS,它们会在同一毫秒
   * 各自「推进排期 + 入队」,agent 把同一条定时指令跑 N 遍。先到的那台写成,其余的读到 false 就该放弃这一轮。
   */
  markTaskFired(
    taskId: string,
    patch: { next_run_at: string | null; last_run_at: string },
    expectedNextRunAt: string | null,
  ): Promise<boolean>
}

export interface RunDueScheduledTasksOptions {
  ownerUserId: string
  nowMs: number
  /** 合成 message_id（任务无真实触发消息）；handleAgentDeliverDeviceCommand 仅用它做 read-mark/seq 解析，
   *  非真实消息时这些后置步骤软失败（命令置 error 终态、不重试）——agent 回合已先跑一次，无重复触发。 */
  newMessageId: () => string
}

export interface RunDueScheduledTasksResult {
  fired: string[]
  skipped: { taskId: string; reason: 'mark_failed' | 'agent_offline' | 'enqueue_failed' | 'claimed_elsewhere' }[]
  /**
   * 这一轮之后**最早的未来到期时刻**（ms）；没有则 null。调用方据此挂一次性定时器，到点才再扫。
   *
   * ⚠️ 只看**未来**的时刻：本轮到期却没能推进排期的任务（agent 离线 / 写排期失败）仍然「已到期」，
   * 把它们算进来会让定时器在 0 ms 后再次触发、原地空转。它们由调用方的周期重排补触发。
   */
  nextDueAtMs: number | null
}

/**
 * 跑一轮到期任务：挑到期 → **先推进排期**（at-most-once-per-interval：投递失败则跳过本轮而非每 tick 狂刷）
 * → 实时查 agent 设备 → 入队 deliver。返回触发/跳过明细。
 */
export async function runDueScheduledTasks(
  gateway: AgentScheduledTaskGateway,
  { ownerUserId, nowMs, newMessageId }: RunDueScheduledTasksOptions,
): Promise<RunDueScheduledTasksResult> {
  const tasks = await gateway.listEnabledTasks(ownerUserId)
  const due = selectDueTasks(tasks, nowMs)
  const result: RunDueScheduledTasksResult = { fired: [], skipped: [], nextDueAtMs: null }
  // 本轮推进过排期的任务：到期时刻以推进后的为准（一次性任务推进成 null）。
  const advanced = new Map<string, string | null>()
  const lastRunAt = new Date(nowMs).toISOString()

  for (const task of due) {
    // agent 离线则**不推进** next_run_at → 任务保持到期，agent 上线后由调用方的周期重排补触发一次（不丢任务运行）。
    const deviceId = await gateway.resolveAgentDeviceId(task.agent_user_id)
    if (!deviceId) {
      result.skipped.push({ taskId: task.id, reason: 'agent_offline' })
      continue
    }

    // 推进 next_run_at 后再入队：推进是 CAS（见 markTaskFired），同一到期时刻只有一方抢得到，抢到的才入队。
    const nextRunAt = task.interval_seconds != null ? computeNextRunAt(task.interval_seconds, nowMs) : null
    try {
      const won = await gateway.markTaskFired(
        task.id,
        { next_run_at: nextRunAt, last_run_at: lastRunAt },
        task.next_run_at,
      )
      // 排期已经被别的设备推进了 —— 这一轮归它,到期时刻同样以推进后的为准(我们不知道具体值,按自己算的那个挂表,
      // 真值由下一次重排读回来)。
      advanced.set(task.id, nextRunAt)
      if (!won) {
        result.skipped.push({ taskId: task.id, reason: 'claimed_elsewhere' })
        continue
      }
    } catch {
      result.skipped.push({ taskId: task.id, reason: 'mark_failed' })
      continue
    }

    try {
      await gateway.enqueueAgentDeliver({
        userId: ownerUserId,
        deviceId,
        agentUserId: task.agent_user_id,
        chatId: task.chat_id,
        messageId: newMessageId(),
        senderUserId: ownerUserId,
        content: task.prompt,
        // 定时任务 = owner 显式意图：结构化点名自己 → 定向穿透 passive 门，
        // 且不篡改 listen_mode（hint 注入走真实档位，不会把 active 纪律毒进该 chat）。
        toUserIds: [task.agent_user_id],
      })
      result.fired.push(task.id)
    } catch {
      result.skipped.push({ taskId: task.id, reason: 'enqueue_failed' })
    }
  }

  result.nextDueAtMs = earliestUpcomingRunAt(tasks, advanced, nowMs)
  return result
}

function earliestUpcomingRunAt(
  tasks: readonly AgentScheduledTaskRow[],
  advanced: ReadonlyMap<string, string | null>,
  nowMs: number,
): number | null {
  let earliest: number | null = null
  for (const task of tasks) {
    if (!task.enabled) continue
    const nextRunAt = advanced.has(task.id) ? advanced.get(task.id) : task.next_run_at
    if (!nextRunAt) continue
    const at = Date.parse(nextRunAt)
    if (!Number.isFinite(at) || at <= nowMs) continue
    if (earliest === null || at < earliest) earliest = at
  }
  return earliest
}
