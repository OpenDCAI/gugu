import { describe, expect, it } from 'vitest'
import { assistantWorkrooms, isDuplicateAssistantChat } from '../../../../apps/desktop/src/lib/assistantChatList'
import type { AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'

const shell = {
  assistantState: 'found', assistant: { id: 'mine', display_name: 'bc', avatar: null, created_at: null }, chatId: 'assistant-dm',
} as AssistantShellSnapshot
const dm = { id: 'assistant-dm', kind: 'dm' as const, peer_user_id: 'mine' }

describe('dedicated assistant entry', () => {
  it('hides only its canonical DM, independently of its name', () => {
    expect(isDuplicateAssistantChat(dm, shell)).toBe(true)
    expect(isDuplicateAssistantChat(dm, { ...shell, assistant: { ...shell.assistant!, display_name: 'renamed' } })).toBe(true)
    expect(isDuplicateAssistantChat({ ...dm, kind: 'group' }, shell)).toBe(false)
    expect(isDuplicateAssistantChat({ ...dm, peer_user_id: 'other-agent' }, shell)).toBe(false)
    expect(isDuplicateAssistantChat({ ...dm, id: 'other-conversation' }, shell)).toBe(false)
  })

  it('keeps the DM available until the shell has actually recognized its assistant', () => {
    expect(isDuplicateAssistantChat(dm, null)).toBe(false)
    expect(isDuplicateAssistantChat(dm, { ...shell, assistantState: 'loading' })).toBe(false)
    expect(isDuplicateAssistantChat(dm, { ...shell, chatId: null })).toBe(false)
    expect(isDuplicateAssistantChat(dm, { ...shell, assistant: null })).toBe(false)
  })

  const sessions = [
    { conversationId: 'root', projectId: 'home', agent: { userId: 'mine' } },
    { conversationId: 'task', projectId: 'home', parentConversationId: 'root', agent: { userId: 'worker' } },
    { conversationId: 'grandchild', projectId: 'home', spawnedByConversationId: 'task', agent: { userId: 'worker-2' } },
    { conversationId: 'unrelated', projectId: 'user-project', agent: { userId: 'other-agent' } },
  ] as SessionpageSessionSummary[]
  const bindings = [{ projectId: 'home', chatId: 'internal' }, { projectId: 'user-project', chatId: 'business-group' }]
  const workrooms = assistantWorkrooms('mine', 'owner', sessions, bindings)
  const group = { id: 'internal', kind: 'group' as const, peer_user_id: null, member_user_ids: ['owner', 'mine', 'worker', 'worker-2'] }

  it('hides the canonical internal workroom, including descendant executors', () => {
    expect(workrooms.chatIds).toEqual(['internal'])
    expect(isDuplicateAssistantChat(group, shell, workrooms)).toBe(true)
    expect(isDuplicateAssistantChat(group, { ...shell, assistant: { ...shell.assistant!, display_name: 'new name' } }, workrooms)).toBe(true)
  })

  it('keeps real collaboration: another human, an unrelated agent, or another group with the same members', () => {
    expect(isDuplicateAssistantChat({ ...group, member_user_ids: [...group.member_user_ids, 'human-friend'] }, shell, workrooms)).toBe(false)
    expect(isDuplicateAssistantChat({ ...group, member_user_ids: [...group.member_user_ids, 'other-agent'] }, shell, workrooms)).toBe(false)
    expect(isDuplicateAssistantChat({ ...group, id: 'business-group' }, shell, workrooms)).toBe(false)
    expect(isDuplicateAssistantChat({ ...group, id: 'same-title-assistant' }, shell, workrooms)).toBe(false)
  })

  it('does not hide on incomplete ownership/membership readings or before the assistant is identified', () => {
    expect(isDuplicateAssistantChat(group, shell)).toBe(false)
    expect(isDuplicateAssistantChat({ ...group, member_user_ids: undefined }, shell, workrooms)).toBe(false)
    expect(isDuplicateAssistantChat({ ...group, member_user_ids: ['owner', 'worker'] }, shell, workrooms)).toBe(false)
    expect(isDuplicateAssistantChat(group, { ...shell, assistantState: 'loading' }, workrooms)).toBe(false)
    expect(assistantWorkrooms('missing', 'owner', sessions, bindings).chatIds).toEqual([])
  })

  it('preserves a group shared with a real user project, even if its current members are all related agents', () => {
    const shared = assistantWorkrooms('mine', 'owner', sessions, [...bindings, { projectId: 'user-project', chatId: 'internal' }])
    expect(isDuplicateAssistantChat(group, shell, shared)).toBe(false)
  })
})
