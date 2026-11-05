// #6264 — 从手机 / 另一台电脑往一台机器上建 agent 时,那台机器可能还没装这个 agent(刚装好的咕咕 server 上
// 一个都没有)。目标机器先装、再启动;装的时间不能算进启动预算(下载 agent 要几分钟,预算只有 150 秒);
// 装失败要按建失败收尾,而不是悄悄吞掉。
import { expect, test, vi } from 'vitest'
import { handleAgentCreateDeviceCommand } from '@gugu/core/local/agent/deviceCommandRuntime'

const payload = {
  agent_user_id: 'agent-6264',
  display_name: 'Codex 1',
  agent_type: 'codex',
  greeting_chat_id: 'chat-6264',
}

const SESSION = {
  guguAgentUserId: 'agent-6264', chatId: 'chat-6264', created: true,
  sessionId: 'conv-1', projectId: 'proj-1',
}

// create / stop 是投递路径用的,这里用不到:给一个调了就响亮报错的实现。
const unused = async (): Promise<never> => {
  throw new Error('not used in agent.create')
}
const BASE = { create: unused, stop: unused }

function startedSession() {
  return vi.fn(async () => (SESSION))
}

test('先装 agent,再启动会话', async () => {
  const order: string[] = []
  const ensureAgentInstalled = vi.fn(async () => {
    order.push('install')
  })
  const startAgentSession = vi.fn(async () => {
    order.push('start')
    return SESSION
  })
  const result = await handleAgentCreateDeviceCommand(payload, {
    runtimeBridge: { ...BASE, ensureAgentInstalled, startAgentSession },
    ownerUserId: 'owner-1',
    deviceId: 'device-1',
  })
  expect(order).toEqual(['install', 'start'])
  expect(ensureAgentInstalled).toHaveBeenCalledWith('codex', expect.any(AbortSignal))
  expect(result.gugu_user_id).toBe('agent-6264')
})

test('装的时间不算进启动预算', async () => {
  const startAgentSession = startedSession()
  const result = await handleAgentCreateDeviceCommand(payload, {
    runtimeBridge: {
      ...BASE,
      // 装得比预算还久:预算若从收到命令就开始计,启动时 signal 已经被掐断。
      ensureAgentInstalled: () => new Promise((resolve) => setTimeout(resolve, 80)),
      startAgentSession: async (input) => {
        expect(input.signal.aborted).toBe(false)
        return startAgentSession()
      },
    },
    ownerUserId: 'owner-1',
    deviceId: 'device-1',
    agentCreateTimeoutMs: 30,
  })
  expect(result.created).toBe(true)
})

test('装失败 = 建失败,会话不启动', async () => {
  const stages: string[] = []
  const startAgentSession = startedSession()
  await expect(
    handleAgentCreateDeviceCommand(payload, {
      runtimeBridge: {
        ...BASE,
        ensureAgentInstalled: async () => {
          throw new Error('在这台机器上安装 codex 失败:network')
        },
        startAgentSession,
      },
      ownerUserId: 'owner-1',
      deviceId: 'device-1',
      onAgentCreateStage: (stage) => stages.push(stage),
    }),
  ).rejects.toThrow('安装 codex 失败')
  expect(startAgentSession).not.toHaveBeenCalled()
  expect(stages).toEqual(['received', 'installing-agent', 'failed'])
})

test('创建框里选的模型 / 思考强度 / 权限模式原样交给宿主;没选就是 null', async () => {
  const startAgentSession = startedSession()
  const bridge = { runtimeBridge: { ...BASE, startAgentSession }, ownerUserId: 'owner-1', deviceId: 'device-1' }
  await handleAgentCreateDeviceCommand(
    { ...payload, model: 'platform:gpt-5.6-sol', effort: 'high', permission_mode: 'full-access' },
    bridge,
  )
  expect(startAgentSession).toHaveBeenLastCalledWith(expect.objectContaining({
    model: 'platform:gpt-5.6-sol', effort: 'high', permissionMode: 'full-access',
  }))
  await handleAgentCreateDeviceCommand(payload, bridge)
  expect(startAgentSession).toHaveBeenLastCalledWith(expect.objectContaining({
    model: null, effort: null, permissionMode: null,
  }))
})
