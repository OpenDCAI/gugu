// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, message } from '../../../support/testHarness'
import { useChatWindowCache } from '../../../../apps/desktop/src/store/chatWindowPublication'

let harness: ReturnType<typeof createReactHarness>
let first: ReturnType<typeof useChatWindowCache>, second: ReturnType<typeof useChatWindowCache>
function CacheOwner({ index }: { index: number }) {
  const value = useChatWindowCache()
  if (index === 1) first = value
  else second = value
  return null
}
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())
describe('shared message cache publication', () => {
  it('replays existing rows and publishes updates and removal without a second cache', async () => {
    await harness.render(<CacheOwner index={1} />)
    const rows = [message({ chat_id: 'task' })]
    first.cache.set('task', rows)
    const observe = vi.fn()
    const stop = first.subscribeChatWindow('task', observe)
    expect(observe).toHaveBeenLastCalledWith(rows)
    first.cache.set('other', [])
    expect(observe).toHaveBeenCalledTimes(1)
    first.cache.delete('task')
    expect(observe).toHaveBeenLastCalledWith([])
    first.cache.set('task', rows)
    first.cache.clear()
    expect(observe).toHaveBeenLastCalledWith([])
    stop(); observe.mockClear()
    first.cache.set('task', rows)
    expect(observe).not.toHaveBeenCalled()
  })
  it('does not publish another account provider’s cache into this pane', async () => {
    await harness.render(<><CacheOwner index={1} /><CacheOwner index={2} /></>)
    const observe = vi.fn()
    const stop = first.subscribeChatWindow('task', observe)
    observe.mockClear()
    second.cache.set('task', [message({ chat_id: 'task' })])
    expect(observe).not.toHaveBeenCalled()
    stop()
  })
})
