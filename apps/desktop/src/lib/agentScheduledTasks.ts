// #987 Agent 定时任务 — 渲染层服务（CRUD）。
// 表 identity.agent_scheduled_tasks（owner RLS）；建任务时解析 owner↔agent 私聊为触发目标 chat_id，
// 并算好首个 next_run_at。触发由设备运行时 tick 负责（见 packages/core/cloud/agentScheduledTasks）。
import { identityDb } from './supabase'
import { chatService } from './chat'
import { i18n } from '@/i18n'
import { platform } from '../platform'

// 表上没有事件:本机设备 runtime 只在兜底周期重读(wake 订着时 5 分钟)。改完说一声,本机的 agent 当场按新表排期。
// 别的设备上改的任务等那一个兜底周期 —— 提前建的不受影响,5 分钟内就到期的可能晚到至多 5 分钟。
const scheduledTasksChanged = () => platform.notifyScheduledTasksChanged?.()

export interface AgentScheduledTask {
  id: string
  agentUserId: string
  ownerUserId: string
  chatId: string
  title: string | null
  prompt: string
  intervalSeconds: number | null
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  createdAt: string
}

interface AgentScheduledTaskRow {
  id: string
  agent_user_id: string
  owner_user_id: string
  chat_id: string
  title: string | null
  prompt: string
  interval_seconds: number | null
  enabled: boolean
  next_run_at: string | null
  last_run_at: string | null
  created_at: string
}

const TASK_COLUMNS =
  'id, agent_user_id, owner_user_id, chat_id, title, prompt, interval_seconds, enabled, next_run_at, last_run_at, created_at'

function mapTask(row: AgentScheduledTaskRow): AgentScheduledTask {
  return {
    id: row.id,
    agentUserId: row.agent_user_id,
    ownerUserId: row.owner_user_id,
    chatId: row.chat_id,
    title: row.title,
    prompt: row.prompt,
    intervalSeconds: row.interval_seconds,
    enabled: row.enabled,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
  }
}

export const MIN_INTERVAL_SECONDS = 60

export const agentScheduledTaskService = {
  async list(agentUserId: string): Promise<AgentScheduledTask[]> {
    const { data, error } = await identityDb
      .from('agent_scheduled_tasks')
      .select(TASK_COLUMNS)
      .eq('agent_user_id', agentUserId)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return (data ?? []).map((row) => mapTask(row as AgentScheduledTaskRow))
  },

  async create(input: {
    agentUserId: string
    ownerUserId: string
    prompt: string
    intervalSeconds: number
    title?: string | null
  }): Promise<AgentScheduledTask> {
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error(i18n.t('scheduledTasks.errors.promptRequired', { ns: 'agents' }))
    if (!Number.isFinite(input.intervalSeconds) || input.intervalSeconds < MIN_INTERVAL_SECONDS) {
      throw new Error(i18n.t('scheduledTasks.errors.intervalMinimum', { ns: 'agents', seconds: MIN_INTERVAL_SECONDS }))
    }
    // 触发目标 = owner↔agent 私聊；建任务时解析并固化（agent 回合在此会话里跑）。
    const chatId = await chatService.getOrCreateDM(input.ownerUserId, input.agentUserId)
    const nextRunAt = new Date(Date.now() + input.intervalSeconds * 1000).toISOString()
    const { data, error } = await identityDb
      .from('agent_scheduled_tasks')
      .insert({
        agent_user_id: input.agentUserId,
        owner_user_id: input.ownerUserId,
        chat_id: chatId,
        title: input.title?.trim() || null,
        prompt,
        schedule_kind: 'interval',
        interval_seconds: Math.floor(input.intervalSeconds),
        enabled: true,
        next_run_at: nextRunAt,
      })
      .select(TASK_COLUMNS)
      .single()
    if (error) throw new Error(error.message)
    scheduledTasksChanged()
    return mapTask(data as AgentScheduledTaskRow)
  },

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const patch: Record<string, unknown> = { enabled, updated_at: new Date().toISOString() }
    if (enabled) {
      // 重新启用：从现在起算下一次，避免 next_run_at 停在过去导致一上来就猛触发。
      const { data } = await identityDb
        .from('agent_scheduled_tasks')
        .select('interval_seconds')
        .eq('id', id)
        .maybeSingle()
      const interval = (data as { interval_seconds?: number | null } | null)?.interval_seconds
      if (interval) patch.next_run_at = new Date(Date.now() + interval * 1000).toISOString()
    }
    const { error } = await identityDb.from('agent_scheduled_tasks').update(patch).eq('id', id)
    if (error) throw new Error(error.message)
    scheduledTasksChanged()
  },

  async remove(id: string): Promise<void> {
    const { error } = await identityDb.from('agent_scheduled_tasks').delete().eq('id', id)
    if (error) throw new Error(error.message)
    scheduledTasksChanged()
  },
}
