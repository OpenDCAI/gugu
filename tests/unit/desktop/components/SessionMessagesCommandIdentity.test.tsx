// @vitest-environment jsdom
import { act, useMemo } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatCommands, ChatContext, ChatState } from '@gugu/session-chat-ui'
import { setLocalePreference } from '@/i18n'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { ChatTranscript, loadChatUi } from '@renderer/lib/chat/chat-transcript'
import { createReactHarness } from '../../../support/testHarness'

const scope = vi.hoisted(() => ({ updates: 0, current: undefined as ChatCommands | undefined }))
vi.mock('@gugu/session-chat-ui', () => ({ createChatView: () => ({
  setCommands: (commands: ChatCommands) => { scope.current = commands; scope.updates++ },
  setShown: () => {}, setPinUserMessages: () => {}, setModel: () => {}, setContentPadding: () => {}, dispose: () => {},
}) }))
const context = {} as ChatContext, state = {} as ChatState
let harness: ReturnType<typeof createReactHarness>
function Panel({ revision, agentName = 'Agent' }: { revision: number; agentName?: string }) {
  const { translate } = useSessionMessages()
  const commands = useMemo<ChatCommands>(() => ({
    conversationAgentName: () => `${agentName} ${translate('task.copyFailed')}`,
  }), [translate, agentName])
  return <div data-revision={revision}><ChatTranscript context={context} state={state} commands={commands} /></div>
}
beforeEach(() => { setLocalePreference('en-US'); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); scope.updates = 0; scope.current = undefined; setLocalePreference('zh-CN') })

it('does not replace transcript commands for 500 unrelated host refreshes', async () => {
  await loadChatUi()
  await harness.render(<Panel revision={0} />)
  scope.updates = 0
  for (let revision = 1; revision <= 500; revision++) await harness.render(<Panel revision={revision} />)
  console.info(JSON.stringify({ hostRefreshes: 500, transcriptCommandReplacements: scope.updates }))
  expect(scope.updates).toBe(0)
})

it('still publishes changed query values and a new locale through the real translation catalog', async () => {
  await loadChatUi()
  await harness.render(<Panel revision={0} />)
  expect(scope.current?.conversationAgentName?.()).toBe(`Agent ${translateSessionMessage('task.copyFailed')}`)
  scope.updates = 0
  await harness.render(<Panel revision={1} agentName="Renamed" />)
  expect(scope.updates).toBe(1)
  expect(scope.current?.conversationAgentName?.()).toBe(`Renamed ${translateSessionMessage('task.copyFailed')}`)
  const english = scope.current?.conversationAgentName?.()
  scope.updates = 0
  await act(async () => { setLocalePreference('zh-CN') })
  expect(scope.updates).toBe(1)
  expect(scope.current?.conversationAgentName?.()).toBe(`Renamed ${translateSessionMessage('task.copyFailed')}`)
  expect(scope.current?.conversationAgentName?.()).not.toBe(english)
})
