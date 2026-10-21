// 会话名册(@ 弹层、把会话拖进终端 / 聊天框都查它)与侧栏身份表都要覆盖别的机器上的会话。
// owner 10-08 实撞:把 ThinkPad 上的终端会话拖进终端,没有任何反应 —— 名册只列本机会话。
// 别的机器上的那一半读会话目录(remote-hosts-store `directoryPeers`,见它的单测);壳口这一口只答本机,
// ❌ 逐台去问:掉线又回来的那台客户端停在 open,问它要等到 frame 超时,弹层一直空着(#7016 实测)。
import { describe, expect, it, vi } from 'vitest'
import { createSessionShellPort, SESSION_SHELL_CHANNELS } from '@shared/lib/ipc/shell-port'

const invokeOnMachine = vi.fn(async () => [])

vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }))
vi.mock('@renderer/lib/electron-api', () => ({ electronApi: vi.fn(), findSessionHostBridge: vi.fn() }))
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  invokeOnMachine: () => invokeOnMachine()
}))

const { machineAwareShellPort } = await import('@renderer/lib/shell-port')

const peer = (sessionId: string) => ({ sessionId, identity: { users: { id: `agent-${sessionId}`, display_name: 'Claude 3', gugu_number: null } }, engine: 'claude' })

describe('壳口的名册与名字表只答本机,❌ 逐台去问', () => {
  it('sessionPeers / agentNames 只问本机宿主,一台机器都不问', async () => {
    const local = createSessionShellPort(async (channel) =>
      channel === SESSION_SHELL_CHANNELS.sessionPeers
        ? [peer('local-1')]
        : [{ conversationId: 'local-1', displayName: 'Claude 3', agentUserId: 'agent-local-1' }]
    )
    const port = machineAwareShellPort(local)
    expect(await port.sessionPeers()).toEqual([peer('local-1')])
    expect(await port.agentNames()).toEqual([{ conversationId: 'local-1', displayName: 'Claude 3', agentUserId: 'agent-local-1' }])
    expect(invokeOnMachine).not.toHaveBeenCalled()
  })

})
