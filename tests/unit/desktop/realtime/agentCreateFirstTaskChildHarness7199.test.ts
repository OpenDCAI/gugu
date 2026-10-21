// #7199 agent.create 的两样新东西:
// - child_harness:这个 agent 开子 agent 不指定 harness 时用哪个,原样交给宿主(宿主核过认得再记到 agent 名下);
// - first_task:建好后系统交给它的第一件事。作为「咕咕系统交的任务」(mode="task")排进启动队列 ——
//   ❌ 冒充主人在私聊里说的话,❌ 沿用系统通知那句「不是请求」(它让「请你做事」自相矛盾);
//   不当首句记:会话仍是常驻出生,首轮没跑成也不影响它之后正常醒来、回私聊(#7223)。
import { expect, test, vi } from 'vitest'
import { handleAgentCreateDeviceCommand, buildFirstTaskPrompt } from '@gugu/core/local/agent/deviceCommandRuntime'
import { arrivalHint, buildSystemNoticeEnvelope, buildSystemTaskEnvelope, readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'

const payload = {
  agent_user_id: 'agent-7199',
  display_name: '个人助理',
  agent_type: 'pi',
  greeting_chat_id: 'chat-7199',
}

const SESSION = {
  guguAgentUserId: 'agent-7199', chatId: 'chat-7199', created: true,
  sessionId: 'conv-1', projectId: 'proj-1',
}

const unused = async (): Promise<never> => {
  throw new Error('not used in agent.create')
}

function bridge() {
  const startAgentSession = vi.fn(async (_input: Record<string, unknown>) => SESSION)
  return {
    startAgentSession,
    options: { runtimeBridge: { create: unused, stop: unused, startAgentSession }, ownerUserId: 'owner-1', deviceId: 'device-1' },
  }
}

const TASK = '初始化:建 today.json,排早晚报。'

test('child_harness 原样交给宿主;没配就是 null', async () => {
  const { startAgentSession, options } = bridge()
  await handleAgentCreateDeviceCommand({ ...payload, child_harness: 'claude' }, options)
  expect(startAgentSession).toHaveBeenLastCalledWith(expect.objectContaining({ childHarness: 'claude' }))
  await handleAgentCreateDeviceCommand(payload, options)
  expect(startAgentSession).toHaveBeenLastCalledWith(expect.objectContaining({ childHarness: null }))
})

test('first_task 排进启动队列:咕咕系统交的任务、带私聊与主人两个 id;不当首句记(常驻出生)', async () => {
  const { startAgentSession, options } = bridge()
  await handleAgentCreateDeviceCommand({ ...payload, first_task: TASK }, options)
  const input = startAgentSession.mock.calls.at(-1)![0] as { initialText?: string; initialPrompt?: string; initialMessageId?: string }
  const prompt = input.initialPrompt!
  expect(prompt).toMatch(/^<gugu_delivery route="system" from="咕咕系统" from_id="system:gugu" msg="msg:/)
  expect(prompt).toContain('mode="task"')
  expect(prompt).toContain(TASK)
  expect(prompt).toContain('chat_id chat-7199')
  expect(prompt).toContain('user:owner-1')
  // 是要做的事,不是通知:arrival 写「照做」,没有那句「不是请求」。
  expect(prompt).toContain('do what it says')
  expect(prompt).not.toContain('not a request')
  // 不记首句 ⇒ origin 是 resident(宿主按 initialText 有无定);也不是谁发的聊天消息。
  expect(input.initialText).toBeUndefined()
  expect(input.initialMessageId).toBeUndefined()
})

test('没有 first_task 也没有主人的第一句 = 常驻,启动队列是空的', async () => {
  const { startAgentSession, options } = bridge()
  await handleAgentCreateDeviceCommand(payload, options)
  const input = startAgentSession.mock.calls.at(-1)![0] as { initialText?: string; initialPrompt?: string }
  expect(input.initialText).toBeUndefined()
  expect(input.initialPrompt).toBeUndefined()
})

test('first_task 与主人的第一句同时来 = 拒建,会话不启动', async () => {
  const { startAgentSession, options } = bridge()
  await expect(handleAgentCreateDeviceCommand({
    ...payload,
    first_task: TASK,
    initial_prompt: '你好',
    initial_message_id: 'msg-1',
  }, options)).rejects.toThrow('mutually exclusive')
  expect(startAgentSession).not.toHaveBeenCalled()
})

test('系统通知与系统任务是两件事:同一个发信方,arrival 一个「不是请求」、一个「照做」', () => {
  const base = { messageId: '00000000-0000-4000-8000-000000007199', content: TASK, at: '2026-10-16 01:00 北京时间 (UTC+8)' }
  expect(buildSystemNoticeEnvelope(base)).toContain('not a request; there is no one to reply to')
  expect(buildSystemNoticeEnvelope(base)).not.toContain('mode="task"')
  expect(arrivalHint('system', 'task')).toContain('do what it says')
  expect(arrivalHint('system', 'task')).toContain('message_send')
  // 通知那一档原样不动。
  expect(arrivalHint('system', null)).toBe('A 咕咕 system notice, not a request; there is no one to reply to.')
  expect(arrivalHint('system', 'notice')).toBe('A 咕咕 system notice, not a request; there is no one to reply to.')
  // 读方认得:同一个 reader 读出发信方、mode、现场事实和正文。
  const read = readDeliveryEnvelope(buildSystemTaskEnvelope({ ...base, context: 'the chat is chat-1' }))
  expect(read?.segments[0]?.facts).toMatchObject({
    route: 'system', mode: 'task', fromId: 'system:gugu', messageContext: 'the chat is chat-1',
  })
  expect(read?.body).toBe(TASK)
})

test('buildFirstTaskPrompt:本机开通与云上开通共用这一个函数', () => {
  const prompt = buildFirstTaskPrompt({ task: TASK, chatId: 'chat-1', ownerUserId: 'owner-9', now: new Date('2026-10-15T17:00:00Z') })
  expect(prompt).toContain('mode="task"')
  expect(prompt).toContain('chat_id chat-1')
  expect(prompt).toContain('user:owner-9')
  expect(prompt).toContain(TASK)
})
