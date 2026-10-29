// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { serializeComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { chat, clickElement, createNode, createReactHarness, displayIdentity, fireContextMenu, message, renderWithAppProviders } from '../../../support/testHarness'
import { writeComposer } from '../../../support/composerEditor'

const mobileShell = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => mobileShell.enabled }))
vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({ topicService: {
  listTopicsOfChat: async () => [], getAgentFloodAdjustment: async () => null, getSourceState: async () => ({ kind: 'gone' }),
} }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {
  getMessages: async () => [], markMessageRead: async () => {}, getOtherMembersReadSeqs: async () => ({}),
  getGroupCollab: async () => ({ snapshot: { scheduler: null, humans: [], agents: [], tasks: [], outputs: [] }, identities: [] }),
} }))

const question = serializeComposerCard({ v: 1, type: 'question', text: 'Pick one', options: ['First', 'Second'], ownerUserId: 'user-1', questionId: 'q1', sessionId: 's1', projectId: 'p1', deviceId: 'd1', machineLabel: 'Mac' })
const task = serializeComposerCard({ v: 1, type: 'task', text: 'A task', agentUserId: 'ada', agentName: 'Ada', sessionId: 's1', projectId: 'p1', deviceId: 'd1', machineLabel: 'Mac' })
let h: ReturnType<typeof createReactHarness>
let repository: AccountImRepository
beforeEach(async () => {
  h = createReactHarness()
  repository = await openImRepository('user-1', { adapter: createMemoryLocalSyncDb() })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { h.cleanup(); repository.close(); vi.unstubAllGlobals() })

for (const kind of ['group', 'dm'] as const) for (const mobile of [false, true]) {
  it.each([
    ['attachment', '[附件] notes.txt (text/plain)\n[Size] 12\n[Kind] file', '看看'],
    ['card', task, '看看'],
    ['card', question, 'First'],
  ] as const)('keeps an ordinary %s reply as plain text (' + kind + ', mobile=' + mobile + ')', async (content_type, content, typed) => {
    mobileShell.enabled = mobile
    const source = message({ id: 'source', chat_id: 'g1', sender_user_id: 'ada', content_type, content })
    const sendMessage = vi.fn(async () => undefined)
    await renderWithAppProviders(h, createNode(ChatAreaPanel, { activeTab: 'chats', mobile }), { chat: {
      activeChatId: 'g1', activeChat: chat({ id: 'g1', kind, peer_user_id: 'ada', name: 'Ada' }), messages: [source],
      identitiesById: { ada: displayIdentity('ada', { display_name: 'Ada', type: 'human' }) },
      getImRepository: async () => repository, sendMessage,
    } })
    const bubble = h.container.querySelector<HTMLElement>('[data-msg-id="source"] [data-testid="message-bubble-action-target"]')!
    await fireContextMenu(bubble)
    await act(async () => { await vi.dynamicImportSettled() })
    const reply = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === '回复')!
    await clickElement(reply)
    const editor = h.container.querySelector<HTMLElement>('[contenteditable]')!
    await act(async () => { writeComposer(editor, typed) })
    await clickElement(h.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!)
    expect(sendMessage).toHaveBeenCalledWith(typed, expect.objectContaining({ replyToMessageId: 'source' }))
  })
}
