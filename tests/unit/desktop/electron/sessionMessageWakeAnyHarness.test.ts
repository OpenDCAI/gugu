import { describe, expect, it, vi } from 'vitest'
import {
  SessionpageLocalDeliveryRouter,
  type SessionpageDeliveryTarget,
} from '../../../../apps/desktop/electron/sessionpage/session-injection'

// 体检 B10:普通消息(session-message outbox)不收时,经路由器唯一的去重唤醒口叫醒会话。从前只有 ACP 那一家在注入里
// 自己踢一脚;现在终端会话(TUI)也一样被叫醒 —— 这是这次合并的行为变化,这一格钉住它。
const SESSION = 'conv-tui-1'

function tuiOwner(accepts: boolean): SessionpageDeliveryTarget {
  return {
    deliveryTargetName: 'tui-owner',
    liveSessionIdByAgent: () => null,
    deliveryKeyForSession: (sessionId) => (sessionId === SESSION ? SESSION : null),
    sessionProviderSurface: () => ({ providerId: 'claude', surface: 'tui' }),
    tryInjectSessionMessage: async () => accepts,
  }
}

const message = { id: 'm-1', text: 'hello' }

describe('an ordinary session message that is not taken wakes the session, whatever harness (B10)', () => {
  it('wakes a terminal (TUI) session whose engine is not running, once, and leaves the message pending', async () => {
    const wakeSession = vi.fn(async () => undefined)
    const router = new SessionpageLocalDeliveryRouter([tuiOwner(false)], { wakeSession, processRunning: () => false })
    await expect(router.tryInjectOrWake(SESSION, message)).resolves.toBe(false)
    await vi.waitFor(() => expect(wakeSession).toHaveBeenCalledWith(SESSION))
    expect(wakeSession).toHaveBeenCalledTimes(1)
  })

  it('does not reopen a session whose engine is running', async () => {
    const wakeSession = vi.fn(async () => undefined)
    const router = new SessionpageLocalDeliveryRouter([tuiOwner(false)], { wakeSession, processRunning: () => true })
    await expect(router.tryInjectOrWake(SESSION, message)).resolves.toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(wakeSession).not.toHaveBeenCalled()
  })

  it('does not wake when the message was taken (positive control: the same router does inject)', async () => {
    const wakeSession = vi.fn(async () => undefined)
    const router = new SessionpageLocalDeliveryRouter([tuiOwner(true)], { wakeSession, processRunning: () => false })
    await expect(router.tryInjectOrWake(SESSION, message)).resolves.toBe(true)
    expect(wakeSession).not.toHaveBeenCalled()
  })
})
