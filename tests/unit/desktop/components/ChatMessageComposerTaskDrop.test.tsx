// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { SCREEN_CONTENT_DRAG_TYPE, type DraggedScreenContent } from '../../../../apps/desktop/src/session/renderer/lib/drag-screen-content'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { readComposer, writeComposer } from '../../../support/composerEditor'
import type { MentionItem } from '@gugu/session-ui/react/components'

const { resolveSession } = vi.hoisted(() => ({ resolveSession: vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/local-session-mention-provider', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/session/renderer/lib/chat/local-session-mention-provider')>(),
  createLocalSessionMentionProvider: () => ({ search: async () => [], resolveSession }),
}))
let harness: ReturnType<typeof createReactHarness>
const member = { id: 'member-agent', name: 'Member', type: 'agent' as const }
const mention = (id: string): MentionItem => ({ id: `aid:${id}`, label: `aid:${id}`, name: 'Task agent', kind: 'custom', role: 'agent' })
const input = () => harness.container.querySelector('[data-testid="chat-composer"]')!
async function drop(content: DraggedScreenContent = { kind: 'session', projectId: 'p', sessionId: 'task-id', title: 'Private task title' }) {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: {
    types: [SCREEN_CONTENT_DRAG_TYPE], getData: () => JSON.stringify(content),
  } })
  await act(async () => { input().dispatchEvent(event) })
}
async function send() {
  await act(async () => { harness.container.querySelector<HTMLButtonElement>('[data-slot="composer-bar"] button[aria-label="发送消息"]')!.click() })
}
beforeEach(() => { harness = createReactHarness(); resolveSession.mockReset() })
afterEach(() => { harness.cleanup() })

describe('task references in the shared chat composer', () => {
  it('leaves chat and App drops untouched rather than resolving them as task mentions', async () => {
    await renderWithAppProviders(harness, <ChatMessageComposer onSend={vi.fn(async () => {})} chatId="chat" />)
    await act(async () => { writeComposer(input(), 'keep typing') })
    await drop({ kind: 'chat', chatId: 'other-chat', title: 'Other chat' })
    await drop({ kind: 'app', tabKind: 'app-test', title: 'App' })
    expect(resolveSession).not.toHaveBeenCalled()
    expect(readComposer(input())).toBe('keep typing')
  })

  it.each([
    { group: true, id: 'member-agent', recipients: ['member-agent'], annotation: null },
    { group: true, id: 'outside-agent', recipients: [], annotation: '不在本群' },
    { group: false, id: 'outside-agent', recipients: [], annotation: null },
  ])('routes group=$group task=$id without changing membership or sharing content', async ({ group, id, recipients, annotation }) => {
    resolveSession.mockResolvedValue(mention(id))
    const onSend = vi.fn(async () => {})
    await renderWithAppProviders(harness, <ChatMessageComposer onSend={onSend} chatId="chat" isGroupChat={group} groupMembers={[member]} />)
    await drop()
    expect(input().querySelector('[data-mention-annotation]')?.textContent ?? null).toBe(annotation)
    expect(input().textContent).not.toContain('Private task title')
    expect(readComposer(input())).toBe(`@[Task agent](aid:${id}) `)
    await send()
    expect(onSend).toHaveBeenCalledWith(`@[Task agent](aid:${id})`, expect.objectContaining({ toUserIds: recipients }))
  })

  it('finishes resolving after an edit, but never inserts into a different chat', async () => {
    let finish!: (item: MentionItem) => void
    resolveSession.mockImplementation(() => new Promise<MentionItem>((resolve) => { finish = resolve }))
    const render = (chatId: string) => renderWithAppProviders(harness, <ChatMessageComposer onSend={vi.fn(async () => {})} chatId={chatId} isGroupChat />)
    await render('a')
    await drop()
    await act(async () => { writeComposer(input(), 'keep typing ') })
    await act(async () => { finish(mention('outside-agent')) })
    expect(readComposer(input())).toBe('keep typing @[Task agent](aid:outside-agent) ')
    await drop()
    await render('b')
    await act(async () => { finish(mention('outside-agent')) })
    expect(readComposer(input())).toBe('')
  })

  it('restores a saved task pill and keeps handwritten references addressable', async () => {
    const onSend = vi.fn(async () => {})
    const text = '@[Saved task](aid:member-agent) check this\r\n@[Private](aid:outside-agent)'
    await renderWithAppProviders(harness, <ChatMessageComposer onSend={onSend} chatId="saved" isGroupChat groupMembers={[member]} />,
      { chat: { drafts: { saved: text } } })
    expect(input().querySelector('[data-mention-id="aid:member-agent"]')).not.toBeNull()
    expect(readComposer(input())).toBe(text.replace(/\r\n/g, '\n'))
    await act(async () => { writeComposer(input(), '@[Handwritten](aid:member-agent) please reply') })
    await send()
    expect(onSend).toHaveBeenCalledWith('@[Handwritten](aid:member-agent) please reply', expect.objectContaining({ toUserIds: ['member-agent'] }))
  })
})
