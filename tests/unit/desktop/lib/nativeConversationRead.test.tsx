// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatView } from '@gugu/session-chat-ui'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { createReactHarness } from '../../../support/testHarness'
import { useNativeConversationRead } from '../../../../apps/desktop/src/hooks/useNativeConversationRead'
import { updateDeviceSessions, removeDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'

const scope = vi.hoisted(() => ({ visible: vi.fn(async (_request: { conversationId: string; itemIds: string[] }) => ({ unreadKeys: ['msg_covered'] })) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: { sessionVisible: scope.visible } }) }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); removeDeviceSessions('host'); scope.visible.mockClear() })

it('opens at the first unread provider identity and acknowledges only visible replies, without scrolling', async () => {
  updateDeviceSessions('host', { sessions: [{ conversationId: 's', nativeInputVersion: 1, nativeUnreadKeys: ['msg_first', 'msg_covered'] } as never] })
  const turns = [{ id: 's:turn:s4', items: ['first', 'covered'].map(name => ({ id: `s:turn:s4:message:msg_${name}`, kind: 'message', role: 'assistant', text: name })) }] as TranscriptTurn[]
  const anchor = vi.fn()
  const revealItem = vi.fn((itemId: string) => { anchor({ kind: 'anchor', itemId, edge: 'top', offset: -8 }); return true })
  let controls!: ReturnType<typeof useNativeConversationRead>
  function Fixture({ shown }: { shown: boolean }) { controls = useNativeConversationRead('host', 's', shown, () => turns); return null }
  await harness.render(<Fixture shown />)
  await act(async () => { controls.onReady({ revealItem } as unknown as ChatView); controls.onVisibleItems(['s:turn:4:message:msg_first']) })
  expect(anchor).toHaveBeenCalledWith({ kind: 'anchor', itemId: 's:turn:s4:message:msg_first', edge: 'top', offset: -8 })
  await vi.waitFor(() => expect(scope.visible).toHaveBeenCalledWith({ conversationId: 's', itemIds: ['s:turn:4:message:msg_first'] }))
  expect(scope.visible.mock.calls.some(([request]) => request.itemIds.includes('s:turn:s4:message:msg_covered'))).toBe(false)
  await harness.render(<Fixture shown={false} />)
  scope.visible.mockClear()
  await act(async () => { controls.onVisibleItems(['s:turn:s4:message:msg_covered']); await new Promise(resolve => setTimeout(resolve, 550)) })
  expect(scope.visible).not.toHaveBeenCalled()
})

it('retries identity navigation after the target render units become available without acknowledging unseen replies', async () => {
  vi.useFakeTimers()
  try {
    updateDeviceSessions('host', { sessions: [{ conversationId: 's', nativeInputVersion: 1, nativeUnreadKeys: ['msg_first'] } as never] })
    const turns = [{ id: 's:turn:s4', items: [{ id: 's:turn:s4:message:msg_first', kind: 'message', role: 'assistant', text: 'Reply' }] }] as TranscriptTurn[]
    let controls!: ReturnType<typeof useNativeConversationRead>
    function Fixture() { controls = useNativeConversationRead('host', 's', true, () => turns); return null }
    const revealItem = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    await harness.render(<Fixture />)
    await act(async () => { controls.onReady({ revealItem } as unknown as ChatView) })
    expect(revealItem).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(revealItem).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(revealItem).toHaveBeenCalledTimes(2)
    expect(scope.visible).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
