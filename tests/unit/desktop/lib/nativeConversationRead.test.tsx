// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatView } from '@gugu/session-chat-ui'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { createReactHarness } from '../../../support/testHarness'
import { useNativeConversationRead } from '../../../../apps/desktop/src/hooks/useNativeConversationRead'
import { useNativeConversationVisibility } from '../../../../apps/desktop/src/lib/nativeConversationVisibility'
import { updateDeviceSessions, removeDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'

const scope = vi.hoisted(() => ({ visible: vi.fn(async (_request: { conversationId: string; itemIds: string[] }) => ({ unreadKeys: ['msg_covered'] })) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: { sessionVisible: scope.visible } }) }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); removeDeviceSessions('host'); scope.visible.mockClear() })

it('publishes the native tail only with a settled visible-item report and drops hidden readers', async () => {
  let controls!: ReturnType<typeof useNativeConversationRead>
  let entries!: ReturnType<typeof useNativeConversationVisibility>
  function Fixture({ shown, sessionId }: { shown: boolean; sessionId: string }) {
    controls = useNativeConversationRead('host', sessionId, shown, () => [])
    entries = useNativeConversationVisibility()
    return null
  }
  await harness.render(<Fixture shown sessionId="s" />)
  await act(async () => controls.onAtBottomChange(true))
  expect(entries.size).toBe(0)
  await act(async () => controls.onVisibleItems(['native-tail']))
  expect([...entries.values()]).toEqual([expect.objectContaining({ sessionId: 's', atTail: true })])
  await act(async () => { controls.onAtBottomChange(false); controls.onVisibleItems(['earlier']) })
  expect([...entries.values()]).toEqual([expect.objectContaining({ atTail: false })])
  await harness.render(<Fixture shown={false} sessionId="s" />)
  await act(async () => controls.onVisibleItems(['hidden']))
  expect(entries.size).toBe(0)
  await harness.render(<Fixture shown sessionId="other" />)
  await act(async () => controls.onVisibleItems(['other-tail-not-confirmed']))
  expect([...entries.values()]).toEqual([expect.objectContaining({ sessionId: 'other', atTail: false })])
})

it.each([1, 2])('acknowledges only visible replies on native input version %s, without scrolling', async version => {
  updateDeviceSessions('host', { sessions: [{ conversationId: 's', nativeInputVersion: version, nativeUnreadKeys: ['msg_first', 'msg_covered'] } as never] })
  const turns = [{ id: 's:turn:s4', items: ['first', 'covered'].map(name => ({ id: `s:turn:s4:message:msg_${name}`, kind: 'message', role: 'assistant', text: name })) }] as TranscriptTurn[]
  const openItem = vi.fn(() => true)
  let controls!: ReturnType<typeof useNativeConversationRead>
  function Fixture({ shown }: { shown: boolean }) { controls = useNativeConversationRead('host', 's', shown, () => turns); return null }
  await harness.render(<Fixture shown />)
  await act(async () => { controls.onReady({ openItem } as unknown as ChatView); controls.onVisibleItems(['s:turn:4:message:msg_first']) })
  expect(openItem).toHaveBeenCalledWith('s:turn:s4:message:msg_first', { preserveActivity: true })
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
    const Fixture = () => { controls = useNativeConversationRead('host', 's', true, () => turns); return null }
    const openItem = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    await harness.render(<Fixture />)
    await act(async () => { controls.onReady({ openItem } as unknown as ChatView) })
    expect(openItem).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(openItem).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(openItem).toHaveBeenCalledTimes(2)
    expect(scope.visible).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
