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
  getMessages: async () => [], getOtherMembersReadSeqs: async () => ({}),
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
    await renderWithAppProviders(h, createNode(ChatAreaPanel, { mobile }), { chat: {
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

it('does not restore an old mobile DM quote or focus the composer after A → B → A', async () => {
  mobileShell.enabled = true
  const source = message({ id: 'source-A', chat_id: 'chat-A', sender_user_id: 'ada', content: 'Alpha Beta' })
  const surface = (id: string) => renderWithAppProviders(h, createNode(ChatAreaPanel, { mobile: true }), { chat: {
    activeChatId: id, activeChat: chat({ id, kind: 'dm', peer_user_id: 'ada', name: id }), messages: id === 'chat-A' ? [source] : [],
    identitiesById: { ada: displayIdentity('ada', { display_name: 'Ada' }) }, getImRepository: async () => repository,
  } })
  await surface('chat-A')
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 0 })
  const bubble = h.container.querySelector<HTMLElement>('[data-msg-id="source-A"] [data-testid="message-bubble-action-target"]')!
  await fireContextMenu(bubble)
  await act(async () => { await vi.dynamicImportSettled() })
  await clickElement([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === '回复')!)
  expect(h.container.querySelector('button[aria-label="取消引用"]')).not.toBeNull()
  h.container.querySelector<HTMLElement>('[contenteditable]')!.blur()
  const added: Node[] = []
  const observer = new MutationObserver(records => records.forEach(record => added.push(...record.addedNodes)))
  observer.observe(h.container, { childList: true, subtree: true })
  const focus = vi.spyOn(HTMLElement.prototype, 'focus')
  await surface('chat-B')
  expect(h.container.querySelector('button[aria-label="取消引用"]')).toBeNull()
  await surface('chat-A')
  observer.takeRecords().forEach(record => added.push(...record.addedNodes)); observer.disconnect()
  expect({ quoteFlashed: added.some(node => node instanceof Element && (node.matches('button[aria-label="取消引用"]') || node.querySelector('button[aria-label="取消引用"]'))),
    quoteVisible: !!h.container.querySelector('button[aria-label="取消引用"]'), composerFocused: focus.mock.instances.some(node => node instanceof HTMLElement && node.matches('[contenteditable]')) })
    .toEqual({ quoteFlashed: false, quoteVisible: false, composerFocused: false })
})

it.each(['dm', 'group'] as const)('keeps the original main %s preview without applying the topic prefix', async kind => {
  const source = message({ id: 'source', chat_id: 'g1', sender_user_id: 'ada', content: 'Alpha first line.\n\nBeta second paragraph.' })
  await renderWithAppProviders(h, createNode(ChatAreaPanel, { mobile: true }), { chat: {
    activeChatId: 'g1', activeChat: chat({ id: 'g1', kind, peer_user_id: 'ada', name: 'Ada' }), messages: [source],
    identitiesById: { ada: displayIdentity('ada', { display_name: 'Ada' }) }, getImRepository: async () => repository,
  } })
  await fireContextMenu(h.container.querySelector<HTMLElement>('[data-msg-id="source"] [data-testid="message-bubble-action-target"]')!)
  await act(async () => { await vi.dynamicImportSettled() })
  await clickElement([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === '回复')!)
  const band = h.container.querySelector('button[aria-label="取消引用"]')!.parentElement!
  expect(band.querySelector('.max-w-60 > div:last-child')?.textContent).toBe(source.content)
})
