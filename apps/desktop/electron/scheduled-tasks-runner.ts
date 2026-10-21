// #987 Agent 定时任务 — electron 侧 gateway 适配器 + tick 入口。
//
// deviceRuntimeHost 的定时任务驱动调 runDueScheduledTasksForOwner（到点才调，不是每 tick）：用 owner 的
// identity-schema client 建 gateway，交给 core 的纯 runDueScheduledTasks 跑（挑到期 → 推进排期 → 复用
// agent.deliver 设备命令链路触发 agent 回合），并把「最早的未来到期时刻」交回宿主去挂下一次定时器。
import { randomUUID } from 'node:crypto'
import {
  runDueScheduledTasks,
  type AgentScheduledTaskGateway,
  type AgentScheduledTaskRow,
} from '@gugu/core/cloud/agentScheduledTasks'
import { insertAgentDeliverDeviceCommand, type DeviceCommandTableClient } from '@gugu/core/cloud/deviceCommands'
import { makeIdentityClient } from './supabase'

export async function runDueScheduledTasksForOwner(ctx: {
  ownerUserId: string
  accessToken: string
  nowMs: number
  deviceId: string | null
}): Promise<{ nextDueAtMs: number | null }> {
  const client = makeIdentityClient(ctx.accessToken)

  const gateway: AgentScheduledTaskGateway = {
    async listEnabledTasks(ownerUserId) {
      const { data, error } = await client
        .from('agent_scheduled_tasks')
        .select('*')
        .eq('owner_user_id', ownerUserId)
        .eq('enabled', true)
      if (error) throw new Error(error.message)
      return (data ?? []) as AgentScheduledTaskRow[]
    },
    async resolveAgentDeviceId(agentUserId) {
      const { data, error } = await client
        .from('users')
        .select('device_id')
        .eq('id', agentUserId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      const deviceId = (data as { device_id?: string | null } | null)?.device_id
      if (typeof deviceId !== 'string' || deviceId.length === 0) return null
      return deviceId
    },
    async enqueueAgentDeliver(input) {
      return insertAgentDeliverDeviceCommand(client as unknown as DeviceCommandTableClient, input)
    },
    async markTaskFired(taskId, patch, expectedNextRunAt) {
      // CAS:只在排期还停在我们读到的那个时刻时才推进(见 gateway 接口上的说明 —— 多台设备同刻到点)。
      const update = client
        .from('agent_scheduled_tasks')
        .update({
          next_run_at: patch.next_run_at,
          last_run_at: patch.last_run_at,
          updated_at: new Date(ctx.nowMs).toISOString(),
        })
        .eq('id', taskId)
      const { data, error } = await (expectedNextRunAt === null
        ? update.is('next_run_at', null)
        : update.eq('next_run_at', expectedNextRunAt)
      ).select('id')
      if (error) throw new Error(error.message)
      return (data ?? []).length > 0
    },
  }

  const result = await runDueScheduledTasks(gateway, {
    ownerUserId: ctx.ownerUserId,
    nowMs: ctx.nowMs,
    newMessageId: () => randomUUID(),
  })
  if (result.fired.length || result.skipped.length) {
    console.log(`[scheduled-tasks] fired=${result.fired.length} skipped=${JSON.stringify(result.skipped)}`)
  }
  return { nextDueAtMs: result.nextDueAtMs }
}
