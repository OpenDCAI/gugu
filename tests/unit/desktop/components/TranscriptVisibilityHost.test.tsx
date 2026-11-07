// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatContext, ChatState, ChatViewOptions } from '@gugu/session-chat-ui'
import { createReactHarness } from '../../../support/testHarness'
import { PageShownContext } from '@renderer/app/recent-session-pages'
import { TabLayerShownContext } from '@renderer/features/tabs/retained-tab-content'
import { ChatTranscript, loadChatUi } from '@renderer/lib/chat/chat-transcript'
import { setEmbedVisible } from '@renderer/lib/portal-container'

const scope = vi.hoisted(() => ({ shown: undefined as boolean | undefined, creates: 0, change: vi.fn() }))
vi.mock('@gugu/session-chat-ui', () => ({ createChatView: (options: ChatViewOptions) => {
  scope.shown = options.shown; scope.creates++
  return { setShown: scope.change, setCommands: () => {}, setPinUserMessages: () => {}, setModel: () => {}, setContentPadding: () => {}, dispose: () => {} }
} }))
const harness = createReactHarness()
afterEach(() => { harness.cleanup(); scope.change.mockClear(); scope.creates = 0; setEmbedVisible(true) })

it('uses page, tab and embed visibility without recreating the retained view', async () => {
  await loadChatUi()
  const context = {} as ChatContext, state = {} as ChatState
  const tree = (page: boolean, tab: boolean) => (
    <PageShownContext.Provider value={page}><TabLayerShownContext.Provider value={tab}>
      <ChatTranscript context={context} state={state} />
    </TabLayerShownContext.Provider></PageShownContext.Provider>
  )
  await harness.render(tree(false, true))
  expect(scope.shown).toBe(false)
  expect(scope.change).toHaveBeenLastCalledWith(false)
  await harness.render(tree(true, true))
  expect(scope.change).toHaveBeenLastCalledWith(true)
  await harness.render(tree(true, false))
  expect(scope.change).toHaveBeenLastCalledWith(false)
  await harness.render(tree(true, true))
  await act(async () => { setEmbedVisible(false) })
  expect(scope.change).toHaveBeenLastCalledWith(false)
  await act(async () => { setEmbedVisible(true) })
  expect(scope.change).toHaveBeenLastCalledWith(true)
  expect(scope.creates).toBe(1)
  harness.cleanup()
  const calls = scope.change.mock.calls.length
  await act(async () => { setEmbedVisible(false) })
  expect(scope.change).toHaveBeenCalledTimes(calls)
})
