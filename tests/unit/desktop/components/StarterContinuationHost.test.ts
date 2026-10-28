// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
const mocks = vi.hoisted(() => ({
  currentPredicates: [] as Array<() => boolean>,
  writeDraft: vi.fn(),
  toast: vi.fn(),
  landPendingStarters: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ writeDraft: mocks.writeDraft }) }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: mocks.toast }) }))
vi.mock('../../../../apps/desktop/src/lib/starterContinuation', () => ({ landPendingStarters: mocks.landPendingStarters }))
import { StarterContinuationHost } from '../../../../apps/desktop/src/components/StarterContinuationHost'
let harness: ReturnType<typeof createReactHarness>
// rendererLogger 拿不到 electron 桥时退化成 console.*,所以「原因进了日志」在这里可判。
let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  harness = createReactHarness()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.currentPredicates.length = 0
  mocks.landPendingStarters.mockImplementation((...args: unknown[]) => {
    mocks.currentPredicates.push(args[3] as () => boolean)
    return Promise.resolve(0)
  })
})
afterEach(() => { harness.cleanup(); consoleError.mockRestore(); vi.clearAllMocks() })
describe('StarterContinuationHost', () => {
  it('keeps durable starter continuation inert before shell activation', async () => {
    const InertStarterContinuationHost = StarterContinuationHost as unknown as (
      props: { active: boolean }
    ) => ReturnType<typeof StarterContinuationHost>
    await harness.render(createNode(InertStarterContinuationHost, { active: false }))
    await act(async () => { await Promise.resolve() })
    expect(mocks.landPendingStarters).not.toHaveBeenCalled()
  })
  it('lands pending starters through the chat store on mount', async () => {
    await harness.render(createNode(StarterContinuationHost))
    await act(async () => { await Promise.resolve() })
    expect(mocks.landPendingStarters).toHaveBeenCalledTimes(1)
    expect(mocks.landPendingStarters).toHaveBeenCalledWith(
      mocks.writeDraft,
      undefined,
      undefined,
      expect.any(Function),
    )
  })
  it('invalidates the exact continuation owner on unmount', async () => {
    await harness.render(createNode(StarterContinuationHost))
    expect(mocks.currentPredicates).toHaveLength(1)
    expect(mocks.currentPredicates[0]()).toBe(true)
    await harness.render(null)
    expect(mocks.currentPredicates[0]()).toBe(false)
  })
  it('surfaces recovery failure without pretending the pointer was cleared', async () => {
    mocks.landPendingStarters.mockRejectedValue(new Error('corrupt starter store'))
    await harness.render(createNode(StarterContinuationHost))
    await act(async () => { await Promise.resolve() })
    expect(mocks.toast).toHaveBeenCalledWith('开场任务恢复失败。请重试。', 'error', 'corrupt starter store')
    expect(consoleError, 'the raw reason must actually be in the log').toHaveBeenCalledWith(
      expect.stringContaining('[agents/starter-continuation]'),
      expect.objectContaining({ err: expect.stringContaining('corrupt starter store') }),
    )
  })
})
