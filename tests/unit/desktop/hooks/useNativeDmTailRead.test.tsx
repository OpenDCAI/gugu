// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeDmTailRead } from '../../../../apps/desktop/src/hooks/useNativeDmTailRead'
import { chat, createReactHarness } from '../../../support/testHarness'
const scope = vi.hoisted(() => ({ write: vi.fn(async (_target: unknown) => undefined), active: true, listener: null as null | ((active: boolean) => void) }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', () => ({ chatSeq: (seq: number) => seq, writeRead: scope.write }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { subscribeAppActive: (listener: (active: boolean) => void) => {
  scope.listener = listener; listener(scope.active); return () => { scope.listener = null }
} } }))
let harness: ReturnType<typeof createReactHarness>
const refresh = vi.fn(async () => undefined)
function fixture() {
  return { chat: chat({ id: 'dm', kind: 'ai', unread_count: 20, last_read_seq: 5, next_message_seq: 26, read_state_version: 3 }), refresh }
}
function Reader({ input }: { input: ReturnType<typeof fixture> }) { useNativeDmTailRead(input); return null }
beforeEach(() => { harness = createReactHarness(); scope.write.mockReset(); scope.write.mockResolvedValue(undefined); refresh.mockClear(); scope.active = true })
afterEach(() => harness.cleanup())

describe('native DM opening watermark', () => {
  it('reads the DM whole on opening and keeps later arrivals outside that opening', async () => {
    const input = fixture()
    await harness.render(<Reader input={input} />)
    await harness.render(<Reader input={{ ...input, chat: { ...input.chat, next_message_seq: 27 } }} />)
    expect(scope.write).toHaveBeenCalledExactlyOnceWith({ kind: 'main', chatId: 'dm', seq: 25 })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('waits for actual foreground without changing the opening watermark', async () => {
    scope.active = false
    const input = fixture()
    await harness.render(<Reader input={input} />)
    expect(scope.write).not.toHaveBeenCalled()
    await act(async () => scope.listener?.(true))
    expect(scope.write).toHaveBeenCalledExactlyOnceWith({ kind: 'main', chatId: 'dm', seq: 25 })
  })

  it('preserves a manual unread intent that arrives while the page is opening', async () => {
    const input = fixture()
    scope.active = false
    await harness.render(<Reader input={input} />)
    await harness.render(<Reader input={{ ...input, chat: { ...input.chat, is_marked_unread: true, read_state_version: 4 } }} />)
    await act(async () => scope.listener?.(true))
    expect(scope.write).not.toHaveBeenCalled()
  })

  it.each([false, true])('leaves another stream unread when the main stream was already read (manual=%s)', async manual => {
    const input = fixture()
    await harness.render(<Reader input={{ ...input, chat: { ...input.chat, last_read_seq: 25, unread_count: 3,
      unread_locator: { stream_kind: 'thread', stream_id: 'thread:dm:root', thread_root_id: 'root', message_id: 'reply',
        message_seq: 24, cursor_seq: 20, unread_count: 3, addressed_count: 3, version: 7, is_marked_unread: manual },
    } }} />)
    expect(scope.write).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('still reaches the captured tail after individual visible replies advance the watermark', async () => {
    scope.active = false
    const input = fixture()
    await harness.render(<Reader input={input} />)
    await harness.render(<Reader input={{ ...input, chat: { ...input.chat, last_read_seq: 12, read_state_version: 4 } }} />)
    await act(async () => scope.listener?.(true))
    expect(scope.write).toHaveBeenCalledExactlyOnceWith({ kind: 'main', chatId: 'dm', seq: 25 })
  })

  it('does not refresh after a failed write or repeatedly submit the same failed opening', async () => {
    scope.write.mockRejectedValueOnce(new Error('offline'))
    const input = fixture()
    await harness.render(<Reader input={input} />)
    await harness.render(<Reader input={{ ...input, chat: { ...input.chat } }} />)
    expect(scope.write).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
  })
})
