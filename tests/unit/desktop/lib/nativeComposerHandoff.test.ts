// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { handoffNativeComposer, registerNativeComposer } from '../../../../apps/desktop/src/lib/nativeComposerHandoff'
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers() })
it('waits for the actual session composer and carries text and the original image together', async () => {
  const receive = vi.fn()
  const image = new File(['image'], 'plot.png', { type: 'image/png' })
  const pending = handoffNativeComposer('task', { text: 'Explain this', files: [image] })
  cleanups.push(registerNativeComposer('other', vi.fn()), registerNativeComposer('task', receive))
  await pending
  expect(receive).toHaveBeenCalledExactlyOnceWith({ text: 'Explain this', files: [image] })
})
it('reports a missing composer so the old draft is retained instead of silently dropped', async () => {
  vi.useFakeTimers()
  const pending = expect(handoffNativeComposer('missing', { text: 'keep me' })).rejects.toThrow('草稿已保留')
  await vi.advanceTimersByTimeAsync(10_000)
  await pending
})
