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
vi.mock('../../../../apps/desktop/src/components/chat/agent-dm-record', () => ({ dmRecordIds: () => scope.aliases }))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory', () => ({ useDirectoryDevices: () => [], directoryRows: () => [], useLiveDeviceSessions: () => ({ host: { sessions: [{ conversationId: 'session', agent: { userId: 'agent' }, nativeUnreadKeys: ['native'], nativeInputVersion: scope.version }] } }) }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.useRealTimers(); scope.first = null; scope.aliases = new Map(); scope.version = undefined; scope.nativeVisible.mockClear() })
it('places a newly arrived MCP first-unread after a native reply already consumed its own landing', async () => {
  const place = vi.fn()
  const revealItem = (itemId: string) => { place({ kind: 'anchor', itemId, edge: 'top', offset: -8 }); return true }
  let reading!: ReturnType<typeof useNativeConversationRead>
  function Fixture() { reading = useNativeConversationRead('host', 'session', true, () => [{ id: 'turn', seq: 0, initiator: 'user', items: [{ id: 'native', seq: 0, kind: 'message', role: 'assistant', text: 'Native reply' }] }]); return null }
  await harness.render(<Fixture />)
  await act(async () => { reading.onReady({ revealItem } as unknown as ChatView) })
  expect(place).toHaveBeenLastCalledWith({ kind: 'anchor', itemId: 'native', edge: 'top', offset: -8 })
  scope.first = 'im-first'; scope.aliases = new Map([['tool:sent:im-first', ['im-first']]])
  await harness.render(<Fixture />)
  expect(place).toHaveBeenLastCalledWith({ kind: 'anchor', itemId: 'tool:sent:im-first', edge: 'top', offset: -8 })
  const calls = place.mock.calls.length
  scope.first = 'im-next'; scope.aliases.set('tool:sent:im-next', ['im-next'])
  await harness.render(<Fixture />)
  expect(place).toHaveBeenCalledTimes(calls)
})

it.each([undefined, 1])('retries a late IM render target independently of native input version %s', async version => {
  vi.useFakeTimers()
  scope.version = version
  scope.first = 'im-first'
  scope.aliases = new Map([['tool:sent:im-first', ['im-first']]])
  const revealItem = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
  let reading!: ReturnType<typeof useNativeConversationRead>
  function Fixture({ shown }: { shown: boolean }) { reading = useNativeConversationRead('host', 'session', shown, () => []); return null }
  await harness.render(<Fixture shown />)
  await act(async () => { reading.onReady({ revealItem } as unknown as ChatView) })
  expect(revealItem).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
  expect(revealItem).toHaveBeenCalledTimes(2)
  expect(revealItem).toHaveBeenLastCalledWith('tool:sent:im-first')
  await harness.render(<Fixture shown={false} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
  expect(revealItem).toHaveBeenCalledTimes(2)
})

it('waits for a late IM alias on an old host without consuming the entry', async () => {
  vi.useFakeTimers()
  scope.first = 'im-first'
  const revealItem = vi.fn().mockReturnValue(true)
  let reading!: ReturnType<typeof useNativeConversationRead>
  function Fixture() { reading = useNativeConversationRead('host', 'session', true, () => []); return null }
  await harness.render(<Fixture />)
  await act(async () => { reading.onReady({ revealItem } as unknown as ChatView); await vi.advanceTimersByTimeAsync(500) })
  expect(revealItem).not.toHaveBeenCalled()
  scope.aliases = new Map([['tool:sent:im-first', ['im-first']]])
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(revealItem).toHaveBeenCalledExactlyOnceWith('tool:sent:im-first')
})

it('keeps native confirmation disabled on an old host even when a reply becomes visible', async () => {
  vi.useFakeTimers()
  let reading!: ReturnType<typeof useNativeConversationRead>
  function Fixture() { reading = useNativeConversationRead('host', 'session', true, () => []); return null }
  await harness.render(<Fixture />)
  await act(async () => { reading.onVisibleItems(['native']); await vi.advanceTimersByTimeAsync(1500) })
  expect(scope.nativeVisible).not.toHaveBeenCalled()
})
