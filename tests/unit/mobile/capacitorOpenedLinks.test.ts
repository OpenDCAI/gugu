// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { capacitorPlatform } from '../../../apps/desktop/src/platform/capacitor'

const m = vi.hoisted(() => ({ addListener: vi.fn(), getLaunchUrl: vi.fn(), remove: vi.fn(async () => {}) }))
vi.mock('@capacitor/app', () => ({ App: m }))

it('consumes the retained cold intent once, and still opens a later click of the same URL', async () => {
  const url = 'gugu-beta://ext/notes/main/cold'
  let send: ((event: { url: string }) => void) | undefined
  // BridgeActivity.load calls onNewIntent(getIntent()); AppPlugin retains that appUrlOpen.
  m.getLaunchUrl.mockResolvedValue({ url })
  m.addListener.mockImplementation(async (_event, listener) => {
    send = listener
    listener({ url })
    return { remove: m.remove }
  })
  const received = vi.fn()
  const stop = capacitorPlatform.subscribeOpenedLinks!(received)
  await m.addListener.mock.results[0]!.value
  expect(received).toHaveBeenCalledExactlyOnceWith(url)
  send!({ url })
  expect(received).toHaveBeenCalledTimes(2)
  stop()
  expect(m.remove).toHaveBeenCalledOnce()
  send!({ url })
  expect(received).toHaveBeenCalledTimes(2)
})
