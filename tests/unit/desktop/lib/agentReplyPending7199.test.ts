import { describe, expect, it } from 'vitest'
import {
  agentReplyPending,
  agentReplyPendingDeadline,
  awaitingReplySince,
  START_PICKUP_MS,
  WAKE_PICKUP_MS,
  type AgentCloudState,
} from '../../../../apps/desktop/src/lib/agentReplyPending'

// #7199 助理聊天里「它在处理」:人发出到它回话一直在,醒来那段也算;等的那几段过了时限不再说(❌ 一直转)。

const T = Date.parse('2026-10-15T15:47:02.000Z')
const line = (is_mine: boolean, at: number, extra: Partial<{ retracted_at: string | null; content_type: 'text' | 'system'; local_send_state: 'sending' | 'failed' | null; thread_root_id: string | null }> = {}) => ({
  is_mine,
  created_at: new Date(at).toISOString(),
  retracted_at: null,
  content_type: 'text' as const,
  local_send_state: null,
  thread_root_id: null,
  ...extra,
})
const awake = (since: number | null): AgentCloudState => ({ presence: 'awake', since })

describe('awaitingReplySince', () => {
  it('最后一句是我说的 = 在等它,从我发出那刻算', () => {
    expect(awaitingReplySince([line(false, T - 60_000), line(true, T)])).toBe(T)
    expect(awaitingReplySince([line(true, T - 5_000), line(true, T)])).toBe(T)
  })
  it('它回过了 / 一句没有 / 我那句没发出去 = 不在等', () => {
    expect(awaitingReplySince([line(true, T), line(false, T + 1_000)])).toBeNull()
    expect(awaitingReplySince([])).toBeNull()
    expect(awaitingReplySince([line(false, T - 1), line(true, T, { local_send_state: 'failed' })])).toBeNull()
  })
  it('撤回的、系统提示、话题里的回复不算最后一句', () => {
    expect(awaitingReplySince([line(true, T), line(false, T + 1, { retracted_at: new Date(T + 2).toISOString() })])).toBe(T)
    expect(awaitingReplySince([line(true, T), line(false, T + 1, { content_type: 'system' })])).toBe(T)
    expect(awaitingReplySince([line(true, T), line(false, T + 1, { thread_root_id: 'root' })])).toBe(T)
  })
  it('正在发的那一条也算(发出那一刻就要接上处理中)', () => {
    expect(awaitingReplySince([line(false, T - 1), line(true, T, { local_send_state: 'sending' })])).toBe(T)
  })
})

describe('agentReplyPending', () => {
  it('读数是在跑 = 在处理,与有没有在等的话无关(运行条读的同一份)', () => {
    expect(agentReplyPending({ status: 'working', cloud: null, awaitingSince: null, now: T })).toBe('working')
  })
  it('没有在等的话、读数也不在跑 = 不说它在处理', () => {
    expect(agentReplyPending({ status: 'idle', cloud: null, awaitingSince: null, now: T })).toBeNull()
    expect(agentReplyPending({ status: 'idle', cloud: { presence: 'waking', since: T }, awaitingSince: null, now: T })).toBeNull()
  })
  it('发出时它在休息:管家叫醒它的那段就是「正在醒来」,过了时限还没醒就不再说', () => {
    const cloud: AgentCloudState = { presence: 'asleep', since: T - 600_000 }
    expect(agentReplyPending({ status: 'offline', cloud, awaitingSince: T, now: T + 5_000 })).toBe('waking')
    expect(agentReplyPending({ status: 'offline', cloud, awaitingSince: T, now: T + WAKE_PICKUP_MS + 1 })).toBeNull()
  })
  it('正在醒 = 「正在醒来」,不论等了多久', () => {
    expect(agentReplyPending({ status: 'offline', cloud: { presence: 'waking', since: T + 600_000 }, awaitingSince: T, now: T + 660_000 })).toBe('waking')
  })
  it('醒了、读数还没翻成在跑:从醒来那刻起等一段(机器还没在库里上线、那一行还是离线也算)', () => {
    const woke = T + 600_000
    expect(agentReplyPending({ status: 'offline', cloud: awake(woke), awaitingSince: T, now: woke + 10_000 })).toBe('working')
    expect(agentReplyPending({ status: 'idle', cloud: awake(woke), awaitingSince: T, now: woke + START_PICKUP_MS - 1 })).toBe('working')
    expect(agentReplyPending({ status: 'idle', cloud: awake(woke), awaitingSince: T, now: woke + START_PICKUP_MS + 1 })).toBeNull()
  })
  it('一直醒着:从我发出那刻起等一段,宿主起一轮还没翻成在跑也算在处理', () => {
    expect(agentReplyPending({ status: 'idle', cloud: awake(T - 3_600_000), awaitingSince: T, now: T + 3_000 })).toBe('working')
    expect(agentReplyPending({ status: 'idle', cloud: null, awaitingSince: T, now: T + 3_000 })).toBe('working')
    expect(agentReplyPending({ status: 'idle', cloud: null, awaitingSince: T, now: T + START_PICKUP_MS + 1 })).toBeNull()
  })
  it('普通宿主离线 / 等人处理 / 出错:消息到不了它手上,❌ 说它在处理', () => {
    for (const status of ['offline', 'needs_user', 'error', 'removed', 'parked'] as const) {
      expect(agentReplyPending({ status, cloud: null, awaitingSince: T, now: T + 1_000 })).toBeNull()
    }
  })
})

describe('agentReplyPendingDeadline', () => {
  it('到点重算的时刻:休息时按叫醒时限,醒着按起一轮的时限(从晚的那一刻算)', () => {
    expect(agentReplyPendingDeadline({ presence: 'asleep', since: null }, T)).toBe(T + WAKE_PICKUP_MS)
    expect(agentReplyPendingDeadline(awake(T + 10), T)).toBe(T + 10 + START_PICKUP_MS)
    expect(agentReplyPendingDeadline(null, T)).toBe(T + START_PICKUP_MS)
    expect(agentReplyPendingDeadline(null, null)).toBeNull()
  })
})

