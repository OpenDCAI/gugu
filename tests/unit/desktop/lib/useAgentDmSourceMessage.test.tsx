// @vitest-environment jsdom
import { act } from 'react'
import type { ChatView } from '@gugu/session-chat-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { askReveal } from '../../../../apps/desktop/src/hooks/useSourceMessageReveal'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { useAgentDmSourceMessage } from '../../../../apps/desktop/src/components/chat/useAgentDmSourceMessage'

let harness: ReturnType<typeof createReactHarness>
let frames: FrameRequestCallback[]
beforeEach(() => {
  harness = createReactHarness(); frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
})
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })
const frame = () => act(async () => { for (const callback of frames.splice(0)) callback(0) })

it('keeps the routed intent until ready, loads its IM anchor and older alias, then centers and flashes', async () => {
  const scrollToItem = vi.fn(), leaveTail = vi.fn(), onMissing = vi.fn()
  const input = {
    chatId: '11111111-1111-4111-8111-111111111111', shown: true, ready: false, view: { current: { scrollToItem } as unknown as ChatView },
    sessionId: 's', turns: [], aliases: new Map<string, readonly string[]>(), messageIds: [] as string[],
    oldestTurnId: 'newer' as string | null, hasOlder: true,
    loadMessageAnchor: vi.fn(async () => { input.messageIds = ['22222222-2222-4222-8222-222222222222']; await render() }),
    loadOlder: vi.fn(async () => { input.oldestTurnId = 'older'; input.aliases = new Map([['native-item', ['22222222-2222-4222-8222-222222222222']]]); input.hasOlder = false; await render() }),
    leaveTail, onMissing,
  }
  let result!: ReturnType<typeof useAgentDmSourceMessage>
  function Probe() { result = useAgentDmSourceMessage(input); return null }
  async function render() { await harness.render(createNode(Probe)) }
  await render()
  await act(async () => { askReveal(input.chatId, '22222222-2222-4222-8222-222222222222'); window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked)) })
  expect(input.loadMessageAnchor).not.toHaveBeenCalled()
  input.ready = true
  await render()
  await frame(); await frame()
  expect(input.loadMessageAnchor).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222')
  expect(input.loadOlder).toHaveBeenCalledOnce()
  expect(scrollToItem).toHaveBeenCalledWith('native-item', { align: 'center' })
  expect(leaveTail).toHaveBeenCalled()
  expect(result.flashMessageId).toBe('native-item')
  expect(onMissing).not.toHaveBeenCalled()
})

it('reports an unavailable canonical anchor without flashing a different item', async () => {
  const scrollToItem = vi.fn(), onMissing = vi.fn()
  function Probe() {
    useAgentDmSourceMessage({ chatId: '33333333-3333-4333-8333-333333333333', shown: true, ready: true, view: { current: { scrollToItem } as unknown as ChatView },
      turns: [], aliases: new Map(), messageIds: [], oldestTurnId: null, hasOlder: false,
      loadMessageAnchor: async () => { throw new Error('not readable') }, loadOlder: async () => {}, leaveTail: vi.fn(), onMissing })
    return null
  }
  await harness.render(createNode(Probe))
  await act(async () => { askReveal('33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'); window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked)) })
  expect(onMissing).toHaveBeenCalledOnce()
  expect(scrollToItem).not.toHaveBeenCalled()
})
