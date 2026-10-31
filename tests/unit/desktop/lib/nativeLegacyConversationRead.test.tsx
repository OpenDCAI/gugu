// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useNativeConversationRead } from '../../../../apps/desktop/src/hooks/useNativeConversationRead'
import type { ChatView } from '@gugu/session-chat-ui'
const scope = vi.hoisted(() => ({ first: null as string | null, aliases: new Map<string, string[]>(), version: undefined as number | undefined, nativeVisible: vi.fn(async () => ({ unreadKeys: [] })) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: { sessionVisible: scope.nativeVisible } }) }))
vi.mock('../../../../apps/desktop/src/lib/chatSummariesBridge', () => ({ useChatSummaries: () => new Map([['dm', { peerUserId: 'agent', firstUnreadMessageId: scope.first }]]) }))
vi.mock('../../../../apps/desktop/src/components/chat/agent-dm-read', () => ({ dmMessageIdsByItem: () => scope.aliases }))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory', () => ({ useDirectoryDevices: () => [], directoryRows: () => [], useLiveDeviceSessions: () => ({ host: { sessions: [{ conversationId: 'session', agent: { userId: 'agent' }, nativeUnreadKeys: ['native'], nativeInputVersion: scope.version }] } }) }))
// The row the mocked IM alias `tool:sent:<id>` is derived from (dmMessageIdsByItem names a sent row after its tool call).
const sentTurn = [{ id: 'turn', seq: 0, initiator: 'agent', items: [{ id: 'tool', seq: 0, kind: 'mcp-tool-call', toolCallId: 'send', title: 'message_send', status: 'done' }] }] as never
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.useRealTimers(); scope.first = null; scope.aliases = new Map(); scope.version = undefined; scope.nativeVisible.mockClear() })
// @@@entry-open: the first unread's folds open once per show; an MCP unread arriving later in the same visit is not
// opened for (#1139 landed on it; nothing moves the reader any more).
it('opens once per show: a newly arrived MCP first-unread after the native one is left as it arrives', async () => {
  const place = vi.fn()
  const openItem = (itemId: string) => { place(itemId); return true }
  let reading!: ReturnType<typeof useNativeConversationRead>
  function Fixture() { reading = useNativeConversationRead('host', 'session', true, () => [{ id: 'turn', seq: 0, initiator: 'user', items: [{ id: 'native', seq: 0, kind: 'message', role: 'assistant', text: 'Native reply' }] }]); return null }
  await harness.render(<Fixture />)
  await act(async () => { reading.onReady({ openItem } as unknown as ChatView) })
  expect(place).toHaveBeenLastCalledWith('native')
  const calls = place.mock.calls.length
  scope.first = 'im-first'; scope.aliases = new Map([['tool:sent:im-first', ['im-first']]])
  await harness.render(<Fixture />)
  expect(place).toHaveBeenCalledTimes(calls)
  scope.first = 'im-next'; scope.aliases.set('tool:sent:im-next', ['im-next'])
  await harness.render(<Fixture />)
  expect(place).toHaveBeenCalledTimes(calls)
})

it.each([undefined, 1])('retries a late IM render target independently of native input version %s', async version => {
  vi.useFakeTimers()
  scope.version = version
  scope.first = 'im-first'
  scope.aliases = new Map([['tool:sent:im-first', ['im-first']]])
  const openItem = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
  let reading!: ReturnType<typeof useNativeConversationRead>
  function Fixture({ shown }: { shown: boolean }) { reading = useNativeConversationRead('host', 'session', shown, () => sentTurn); return null }
  await harness.render(<Fixture shown />)
  await act(async () => { reading.onReady({ openItem } as unknown as ChatView) })
  expect(openItem).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
  expect(openItem).toHaveBeenCalledTimes(2)
  expect(openItem).toHaveBeenLastCalledWith('tool:sent:im-first')
  await harness.render(<Fixture shown={false} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
  expect(openItem).toHaveBeenCalledTimes(2)
})

it('waits for a late IM alias on an old host without consuming the entry', async () => {
  vi.useFakeTimers()
  scope.first = 'im-first'
  const openItem = vi.fn().mockReturnValue(true)
  let reading!: ReturnType<typeof useNativeConversationRead>
  function Fixture() { reading = useNativeConversationRead('host', 'session', true, () => sentTurn); return null }
  await harness.render(<Fixture />)
  await act(async () => { reading.onReady({ openItem } as unknown as ChatView); await vi.advanceTimersByTimeAsync(500) })
  expect(openItem).not.toHaveBeenCalled()
  scope.aliases = new Map([['tool:sent:im-first', ['im-first']]])
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(openItem).toHaveBeenCalledExactlyOnceWith('tool:sent:im-first')
})

it('keeps native confirmation disabled on an old host even when a reply becomes visible', async () => {
  vi.useFakeTimers()
  let reading!: ReturnType<typeof useNativeConversationRead>
  function Fixture() { reading = useNativeConversationRead('host', 'session', true, () => []); return null }
  await harness.render(<Fixture />)
  await act(async () => { reading.onVisibleItems(['native']); await vi.advanceTimersByTimeAsync(1500) })
  expect(scope.nativeVisible).not.toHaveBeenCalled()
})
