import { describe, expect, it } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { taskChatRows, taskChatWindow } from '../../../../apps/desktop/src/components/assistant/taskChatRows'
import type { AssistantTaskChat } from '../../../../apps/desktop/src/lib/assistantTaskChat'
import type { TaskExchange } from '../../../../apps/desktop/src/session/shared/core/sessions/task-collaboration'

const task: AssistantTaskChat = { assistantId: 'assistant-id', taskAgentId: 'task-id', task: { deviceId: 'worker', sessionId: 'task-session' }, assistants: [{ deviceId: 'home', sessionId: 'assistant-session' }] }
const exchange = (id: string, fromSessionId: string, toSessionId: string, second: number): TaskExchange => ({ id, position: second, fromSessionId, toSessionId, content: `report ${id}`, createdAt: `2026-10-16T12:00:0${second}Z` })
const human = { id: 'human-message', chat_id: 'dm', sender_user_id: 'owner', content: 'please continue', created_at: '2026-10-16T12:00:02Z', seq: 1 } as MessageItem

describe('one task chat with three real senders', () => {
  it('bounds initial collaboration rendering and keeps earlier records reachable without dropping IM messages', () => {
    const entries = Array.from({ length: 180 }, (_, index) => ({ ...exchange(String(index), 'assistant-session', 'task-session', 1), createdAt: new Date(Date.parse('2026-10-16T12:00:00Z') + index * 1000).toISOString() }))
    const all = taskChatRows([human], entries, task, '')
    expect(taskChatWindow(all, 80)).toMatchObject({ earlier: 100, rows: expect.arrayContaining([expect.objectContaining({ message: human })]) })
    expect(taskChatWindow(all, 80).rows).toHaveLength(81)
    expect(taskChatWindow(all, 160).rows).toHaveLength(161)
    expect(taskChatWindow(all, 240)).toEqual({ rows: all, earlier: 0 })
  })
  it('interleaves delegation, user message, and task report with original identities', () => {
    const delegation = exchange('delegation', 'assistant-session', 'task-session', 1)
    const report = exchange('report', 'task-session', 'assistant-session', 3)
    const rows = taskChatRows([human], [report, delegation, report], task, '')
    expect(rows.map((row) => row.message.sender_user_id)).toEqual(['assistant-id', 'owner', 'task-id'])
    expect(rows.map((row) => row.message.id)).toEqual(['session-direct:delegation', 'human-message', 'session-direct:report'])
    expect(rows[0]).toMatchObject({ type: 'task-exchange', recipientUserId: 'task-id', message: { is_mine: true, sender_user_id: 'assistant-id' } })
    expect(rows[2]).toMatchObject({ type: 'task-exchange', recipientUserId: 'assistant-id', message: { is_mine: false, sender_user_id: 'task-id' } })
    expect(rows[1]!.message).toBe(human)
  })
  it('keeps a report after a human message within the same second', () => {
    const incoming = { ...human, created_at: '2026-10-16T12:00:01.200Z' }
    const report = { ...exchange('report', 'task-session', 'assistant-session', 1), createdAt: '2026-10-16T12:00:01.300Z' }
    expect(taskChatRows([incoming], [report], task, '').map((row) => row.message.id)).toEqual(['human-message', 'session-direct:report'])
  })
  it('excludes other tasks and unrelated correspondents in both directions', () => {
    const rows = taskChatRows([human], [exchange('other', 'other-task', 'assistant-session', 1), exchange('other', 'assistant-session', 'other-task', 2), exchange('stranger', 'stranger', 'task-session', 3)], task, '')
    expect(rows.map((row) => row.message.id)).toEqual(['human-message'])
  })
  it('searches collaboration text and leaves ordinary chats in their original order', () => {
    expect(taskChatRows([], [exchange('needle', 'assistant-session', 'task-session', 1)], task, 'NEEDLE')).toHaveLength(1)
    expect(taskChatRows([], [exchange('needle', 'assistant-session', 'task-session', 1)], task, 'absent')).toHaveLength(0)
    expect(taskChatRows([human], [], null, '')[0]!.message).toBe(human)
  })
})
