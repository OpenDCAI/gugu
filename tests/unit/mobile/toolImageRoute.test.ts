// @vitest-environment jsdom
//
// 复核 47b50d577:手机取一张工具图走一问一答(`once` → taskhost.call):有 12 秒期限、回包是一条独立的广播。
// 走窗口(`rpc` → invoke)的话那一问没有期限,线活着就一直等;一片回包丢了还会把这条会话的推送一起压住。
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: vi.fn(), subscribeDeviceRpcEvents: vi.fn() }))
vi.mock('@/lib/remoteSessionHost', () => ({ openPhoneSessionHostPipe: vi.fn(() => new Promise(() => {})) }))

const { callDeviceRpc } = await import('@/lib/deviceRpc')
const { SESSION_HOST_RPC } = await import('@/session/shared/lib/ipc/session-host-device-frames')
const { fetchToolImage } = await import('@/mobile/agent-watch/sessionpage-rpc')

describe('手机取一张工具图走哪条路', () => {
  it('一问一答,12 秒期限;❌ 走窗口', async () => {
    const shot = { mimeType: 'image/png', data: 'iVBORw0KGgo' }
    vi.mocked(callDeviceRpc).mockResolvedValue({ result: { value: { ok: true, value: shot } } } as never)
    const reply = fetchToolImage('device-1', 'conversation-1', 'tc1', 2)
    await Promise.resolve()
    expect(callDeviceRpc).toHaveBeenCalledWith(
      'device-1',
      SESSION_HOST_RPC.call,
      { channel: 'sessionTimeline.sessionToolImage', args: [{ conversationId: 'conversation-1', itemId: 'tc1', index: 2 }] },
      { timeoutMs: 12_000 },
    )
    await expect(reply).resolves.toEqual(shot)
  })
})
