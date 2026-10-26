// OpenDCAI/gugu#446 手机在项目里派任务:那台电脑上建会话(派出的群、文件夹都交过去),回会话与卡上开出的话题。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const created = vi.hoisted(() => ({ requests: [] as Array<Record<string, unknown>>, result: {} as Record<string, unknown> }))
const topics = vi.hoisted(() => ({ rows: [] as Array<{ chat_id: string; source_message_id: string }> }))

vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  createSession: vi.fn(async (_deviceId: string, request: Record<string, unknown>) => {
    created.requests.push(request)
    return created.result
  }),
}))
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({
  topicService: { listTopicsOfChat: vi.fn(async () => topics.rows) },
}))

const { createTaskInGroup, TaskInGroupError } = await import('../../../../apps/desktop/src/mobile/agent-watch/createTaskInGroup')

const input = { deviceId: 'mac-1', projectId: 'proj-1', cwd: '/work/site', chatId: 'chat-project-1', prompt: '修好登录页', harness: 'claude' }

beforeEach(() => {
  created.requests.length = 0
  created.result = { conversationId: 'session-1', projectId: 'proj-1', title: '修好登录页', taskMessageId: 'card-1' }
  topics.rows = [{ chat_id: 'topic-other', source_message_id: 'card-0' }, { chat_id: 'topic-1', source_message_id: 'card-1' }]
})

describe('createTaskInGroup', () => {
  it('carries the machine remembered coding view and local model into the same task-topic path', async () => {
    await createTaskInGroup({ ...input, model: 'sonnet', sessionView: 'code', permissionMode: 'full-access', effort: 'high' })
    expect(created.requests[0]).toMatchObject({ model: 'sonnet', sessionView: 'code', permissionMode: 'full-access', effort: 'high', taskChatId: input.chatId })
  })
  it('asks that computer for a dispatched task in the folder and returns the topic opened off its card', async () => {
    await expect(createTaskInGroup({ ...input, model: 'sonnet' })).resolves.toEqual({ sessionId: 'session-1', topicChatId: 'topic-1' })
    expect(created.requests).toEqual([{
      projectId: 'proj-1', cwd: '/work/site', harness: 'claude', prompt: '修好登录页', model: 'sonnet',
      chatId: 'chat-project-1', taskChatId: 'chat-project-1',
    }])
  })

  it('a computer that does not know dispatched tasks is named, with the session it made', async () => {
    created.result = { conversationId: 'session-1', projectId: 'proj-1', title: 'x' }
    const error = await createTaskInGroup(input).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TaskInGroupError)
    expect(error).toMatchObject({ code: 'host_outdated', sessionId: 'session-1' })
  })

  it('an agent that did not start says why; no topic is looked for', async () => {
    created.result = { ...created.result, startFailure: 'agent_signed_out' }
    await expect(createTaskInGroup(input)).rejects.toMatchObject({ code: 'start_failed', message: 'agent_signed_out', sessionId: 'session-1' })
  })

  it('a card with no topic on it is a loud failure, not a silent session', async () => {
    topics.rows = []
    await expect(createTaskInGroup(input)).rejects.toMatchObject({ code: 'topic_missing', sessionId: 'session-1' })
  })
})
