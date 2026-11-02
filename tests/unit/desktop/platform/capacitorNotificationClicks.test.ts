// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { capacitorPlatform } from '../../../../apps/desktop/src/platform/capacitor'

const { addListener } = vi.hoisted(() => ({ addListener: vi.fn() }))
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: { addListener } }))
vi.mock('@capacitor-mlkit/barcode-scanning', () => ({ BarcodeFormat: { QrCode: 'QR_CODE' }, BarcodeScanner: {} }))

type Tap = { actionId: string; notification: { extra?: { chatId?: unknown } } }
let fire: (event: Tap) => void
let remove: Mock<() => Promise<void>>
beforeEach(() => {
  addListener.mockReset()
  remove = vi.fn(async () => {})
  addListener.mockImplementation(async (_event, listener) => { fire = listener; return { remove } })
})

describe('phone system notification clicks', () => {
  it.each(['c1', undefined, '', 42, null])('forwards only a non-empty chatId, otherwise null: %j', (chatId) => {
    const listener = vi.fn()
    const stop = capacitorPlatform.subscribeNotificationClicks!(listener)
    expect(addListener).toHaveBeenCalledWith('localNotificationActionPerformed', expect.any(Function))
    fire({ actionId: 'tap', notification: { extra: { chatId } } })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ chatId: chatId === 'c1' ? 'c1' : null })
    stop()
  })

  it('ignores other actions and delivers a tap without extra as null', () => {
    const listener = vi.fn()
    const stop = capacitorPlatform.subscribeNotificationClicks!(listener)
    fire({ actionId: 'dismiss', notification: { extra: { chatId: 'c1' } } })
    expect(listener).not.toHaveBeenCalled()
    fire({ actionId: 'tap', notification: {} })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ chatId: null })
    stop()
  })

  it('delivers the retained cold-start tap during registration', () => {
    addListener.mockImplementationOnce(async (_event, listener) => {
      listener({ actionId: 'tap', notification: { extra: { chatId: 'cold-chat' } } })
      return { remove }
    })
    const listener = vi.fn()
    const stop = capacitorPlatform.subscribeNotificationClicks!(listener)
    expect(listener).toHaveBeenCalledExactlyOnceWith({ chatId: 'cold-chat' })
    stop()
  })

  it('removes the registered handle once and ignores taps after unsubscribe', async () => {
    const listener = vi.fn()
    const stop = capacitorPlatform.subscribeNotificationClicks!(listener)
    await Promise.resolve()
    stop()
    stop()
    fire({ actionId: 'tap', notification: { extra: { chatId: 'late-chat' } } })
    expect(listener).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('removes a handle that arrives after unsubscribe', async () => {
    const registration = Promise.withResolvers<{ remove: () => Promise<void> }>()
    addListener.mockImplementationOnce((_event, listener) => { fire = listener; return registration.promise })
    const listener = vi.fn()
    const stop = capacitorPlatform.subscribeNotificationClicks!(listener)
    stop()
    fire({ actionId: 'tap', notification: { extra: { chatId: 'late-chat' } } })
    registration.resolve({ remove })
    await registration.promise
    expect(remove).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()
  })
})
