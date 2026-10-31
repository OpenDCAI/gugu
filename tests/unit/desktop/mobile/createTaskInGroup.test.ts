// OpenDCAI/gugu#446 手机在项目里派任务:那台电脑上建会话(派出的群、文件夹都交过去),回会话 id;卡落在群里,agent 在群里回(同普通群)。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const created = vi.hoisted(() => ({ requests: [] as Array<Record<string, unknown>>, result: {} as Record<string, unknown> }))

vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  createSession: vi.fn(async (_deviceId: string, request: Record<string, unknown>) => {
    created.requests.push(request)
    return created.result
  }),
}))

const { createTaskInGroup, TaskInGroupError } = await import('../../../../apps/desktop/src/mobile/agent-watch/createTaskInGroup')

const input = { deviceId: 'mac-1', projectId: 'proj-1', cwd: '/work/site', chatId: 'chat-project-1', prompt: '修好登录页', harness: 'claude' }

beforeEach(() => {
  created.requests.length = 0
  created.result = { conversationId: 'session-1', projectId: 'proj-1', title: '修好登录页', taskMessageId: 'card-1' }
})

describe('createTaskInGroup', () => {
  it('carries the machine remembered coding view and local model into the same task path', async () => {
    await createTaskInGroup({ ...input, model: 'sonnet', permissionMode: 'full-access', effort: 'high' })
    expect(created.requests[0]).toMatchObject({ model: 'sonnet', permissionMode: 'full-access', effort: 'high', taskChatId: input.chatId })
    // 展示不由手机带:那台电脑按自己的「终端」开关定。
    expect(created.requests[0]).not.toHaveProperty('sessionView')
  })
  it('asks that computer for a dispatched task in the folder and returns the session it made', async () => {
    await expect(createTaskInGroup({ ...input, model: 'sonnet' })).resolves.toEqual({ sessionId: 'session-1' })
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

  it('an agent that did not start says why', async () => {
    created.result = { ...created.result, startFailure: 'agent_signed_out' }
    await expect(createTaskInGroup(input)).rejects.toMatchObject({ code: 'start_failed', message: 'agent_signed_out', sessionId: 'session-1' })
  })

})
