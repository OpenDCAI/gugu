// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import type { SessionLiveReply } from '@gugu/session-core/session-record/contract'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
const mocks = vi.hoisted(() => ({
  read: { phase: 'ready', link: 'ok', timeline: { liveReply: null as SessionLiveReply | null } },
  client: vi.fn(() => ({})),
}))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/use-timeline-session', () => ({ useTimelineSession: () => mocks.read }))
vi.mock('../../../../apps/desktop/src/components/assistant/assistantTimelineClient', () => ({ assistantTimelineClient: mocks.client }))
import { AssistantTypingLive } from '../../../../apps/desktop/src/components/assistant/AssistantTypingLive'
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  mocks.read.phase = 'ready'; mocks.read.link = 'ok'
  mocks.read.timeline.liveReply = { sourceMessageId: 'msg:current', activity: { phase: 'thinking', id: 'thought', text: 'Thinking information', startedAt: Date.now() } }
})
afterEach(() => harness.cleanup())
const view = (messageId = 'current', local = true) => <AssistantTypingLive deviceId="device" sessionId="session" local={local} messageId={messageId} pending="working" name="bc" />
it('only shows this message’s thinking on a live, synchronized link', async () => {
  await harness.render(view())
  expect(harness.container.textContent).toContain('正在思考')
  await harness.render(view('other'))
  expect(harness.container.textContent).not.toContain('思考')
})
it('clears stale thinking immediately on link loss, loading or old-host responses', async () => {
  await harness.render(view())
  mocks.read.link = 'lost'
  await harness.render(view())
  expect(harness.container.textContent).toContain('处理中')
  expect(harness.container.textContent).not.toContain('思考')
  mocks.read.link = 'connecting'; mocks.read.phase = 'loading'
  await harness.render(view())
  expect(harness.container.textContent).not.toContain('思考')
  mocks.read.link = 'ok'; mocks.read.phase = 'ready'; mocks.read.timeline.liveReply = null
  await harness.render(view())
  expect(harness.container.textContent).not.toContain('思考')
})
it('uses the actual endpoint transport for remote hosts too', async () => {
  await harness.render(view('current', false))
  expect(mocks.client).toHaveBeenLastCalledWith(false)
  expect(harness.container.textContent).toContain('正在思考')
})
it('shows actual tool counts instead of generic processing and clears them on link loss', async () => {
  mocks.read.timeline.liveReply = { sourceMessageId: 'msg:current', activity: { phase: 'tools', count: 3 } }
  await harness.render(view())
  expect(harness.container.textContent).toContain('调用 3 次工具')
  expect(harness.container.textContent).not.toContain('处理中')
  mocks.read.link = 'lost'
  await harness.render(view())
  expect(harness.container.textContent).not.toContain('3 次工具')
})
