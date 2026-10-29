// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { agentSendOf } from '@gugu/session-core/session-record/reply-process'
import { agentSendLabel } from '@session-chat/state/agent-send'
import { withSentReplies } from '@session-chat/state/sent-replies'
import { defaultChatTranslator } from '@session-chat/localization'
import type { ChatMessage } from '@session-chat/model'
import { publishChatSummaries, resolveChatId, subscribeChatSummaries } from '@/lib/chatSummariesBridge'
import { chatDisplayName } from '@renderer/lib/chat/chat-name'

const project = vi.hoisted(() => ({ chatId: '', name: '' }))
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({
  projectGroupsStore: { projectOfChat: (id: string) => id === project.chatId ? 'project' : undefined },
}))
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => ({}), projectDisplayName: () => project.name,
}))

const CHAT = '127ec4f0-30b1-4583-b469-706756153bdd'
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
type McpToolCall = Extract<TranscriptTurn['items'][number], { kind: 'mcp-tool-call' }>
const group = (extra: { public_id?: number | null; name?: string; alias?: string | null } = {}) =>
  ({ id: CHAT, kind: 'group', unread_count: 0, public_id: 216012, name: 'Design review', ...extra })
const send = (chatId: string): McpToolCall => ({
  kind: 'mcp-tool-call', id: 'send', seq: 1, toolCallId: 'call', title: 'message_send',
  server: 'gugu', tool: 'message_send', status: 'done',
  rawInput: JSON.stringify({ chat_id: chatId, text: 'Background result' }),
  outputText: 'sent (id=msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73)',
})
const backgroundTurn = (chatId: string): TranscriptTurn => ({
  id: 'background', seq: 2, initiator: 'agent', items: [send(chatId)], outcome: { kind: 'done' },
})

beforeEach(() => {
  project.chatId = ''; project.name = ''
  publishChatSummaries([])
})

describe('send destinations resolved from the signed-in chat list', () => {
  it('names a successful background send by its public number with no incoming message or rawOutput', () => {
    publishChatSummaries([group(), { ...group({ public_id: 216013, name: 'Other group' }), id: OTHER }])
    const turn = withSentReplies(backgroundTurn('216012'), { allDestinations: true })
    const replies = turn.items.filter(item => item.kind === 'message') as ChatMessage[]
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ text: 'Background result', sentChat: '216012' })
    expect(replies[0].sentReplyTo).toBeUndefined()
    expect(agentSendLabel(replies[0].sentTo!, defaultChatTranslator, chatDisplayName)).toBe('Sent to Design review')
    // Session-page and phone tool rows use the same host resolver as conversation bubbles.
    expect(agentSendLabel(agentSendOf(send('216013'))!.to, defaultChatTranslator, chatDisplayName)).toBe('Sent to Other group')
  })

  it('keeps canonical UUID, project-name and alias behavior when resolving a public number', () => {
    publishChatSummaries([group()])
    project.chatId = CHAT; project.name = 'Project name'
    expect(chatDisplayName(CHAT)).toBe('Project name')
    expect(chatDisplayName('216012')).toBe('Project name')
    publishChatSummaries([group({ alias: 'My alias' })])
    expect(chatDisplayName('216012')).toBe('My alias')
    publishChatSummaries([])
    expect(chatDisplayName(CHAT)).toBe('Project name')
  })

  it('notifies once when a public number appears, changes or disappears, and resolves renamed chats', () => {
    const listener = vi.fn()
    const off = subscribeChatSummaries(listener)
    try {
      publishChatSummaries([group()])
      expect(resolveChatId('216012')).toBe(CHAT)
      publishChatSummaries([group()])
      expect(listener).toHaveBeenCalledTimes(1)
      publishChatSummaries([group({ name: 'Renamed' })])
      expect(chatDisplayName('216012')).toBe('Renamed')
      publishChatSummaries([group({ public_id: 216014 })])
      expect(resolveChatId('216012')).toBeNull()
      expect(resolveChatId('216014')).toBe(CHAT)
      publishChatSummaries([group({ public_id: null })])
      expect(resolveChatId('216014')).toBeNull()
      expect(listener).toHaveBeenCalledTimes(4)
    } finally { off() }
    publishChatSummaries([])
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it.each(['999', '0', '-1', '216012junk', ' 216012', '2.16012e5', '9007199254740992'])('keeps an unknown or invalid address unavailable: %s', address => {
    publishChatSummaries([group()])
    expect(resolveChatId(address)).toBeNull()
    expect(agentSendLabel(agentSendOf(send(address))!.to, defaultChatTranslator, chatDisplayName)).toBe('Sent · destination name unavailable')
  })

  it('does not retain destinations from the previous account chat list', () => {
    publishChatSummaries([group()])
    expect(chatDisplayName('216012')).toBe('Design review')
    publishChatSummaries([{ ...group({ public_id: 216013, name: 'Signed-in group' }), id: OTHER }])
    expect(chatDisplayName('216012')).toBeNull()
    expect(chatDisplayName('216013')).toBe('Signed-in group')
  })
})
