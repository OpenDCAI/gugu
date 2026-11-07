// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { chat, createReactHarness, device } from '../../../support/testHarness'
import { useNativeAgentChats } from '../../../../apps/desktop/src/hooks/useNativeAgentChats'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishDirectoryDevices, removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'

vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => false }))
let harness: ReturnType<typeof createReactHarness> | undefined
let release: (() => void) | undefined
afterEach(() => { harness?.cleanup(); release?.(); release = undefined; publishDirectoryDevices([]); removeDeviceSessions('host') })

it.each([10, 100, 1000])('merges native messages for one changed row among %i agent chats', async size => {
  const reads: string[] = []
  const sessions: SessionpageSessionSummary[] = Array.from({ length: size }, (_, index) => ({
    conversationId: `s${index}`, projectId: 'project', title: `S${index}`, harness: 'codex', runtime: 'acp', agentStatus: 'idle',
    lastInteractedAt: '2026-11-06T12:00:00Z', supported: true, agent: { userId: `agent${index}` },
    get nativeLastMessage() { reads.push(`agent${index}`); return { text: `reply${index}`, at: '2026-11-06T12:00:00Z' } },
  }))
  release = installOwnedAgentEntry({ owns: () => true, open: () => true })
  publishDirectoryDevices([device('host', [])])
  updateDeviceSessions('host', { sessions, cached: false, loading: false })
  harness = createReactHarness()
  let projected: ChatItem[] = []
  function Fixture({ rows }: { rows: ChatItem[] }) { projected = useNativeAgentChats(rows); return null }
  const rows = sessions.map((_, index) => chat({ id: `c${index}`, kind: 'dm', peer_user_id: `agent${index}` }))
  await harness.render(<Fixture rows={rows} />)
  const held = projected
  reads.length = 0
  await harness.render(<Fixture rows={[{ ...rows[0]!, unread_count: 3 }, ...rows.slice(1)]} />)
  console.info('native message reads', reads)
  expect(reads).toEqual(['agent0'])
  expect(projected[0]!.unread_count).toBe(3)
  expect(projected[0]!.last_message_preview).toBe('reply0')
  expect(projected[1]).toBe(held[1])
  reads.length = 0
  await act(async () => updateDeviceSessions('host', { sessions: [{ ...sessions[0]!, nativeLastMessage: { text: 'updated', at: '2026-11-06T13:00:00Z' } }, ...sessions.slice(1)] }))
  expect(projected[0]!.last_message_preview).toBe('updated')
  expect(reads.every(id => id === 'agent0')).toBe(true)
  await act(async () => { release?.(); release = installOwnedAgentEntry({ owns: () => false, open: () => false }) })
  expect(projected[0]!.last_message_preview).toBe(rows[0]!.last_message_preview)
})
