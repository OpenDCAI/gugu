// @vitest-environment jsdom
import { act, useLayoutEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { readComposer, writeComposer } from '../../../support/composerEditor'
import { plainTextDoc, serializeDoc } from '../../../../packages/session-ui/src/react/components/prompt-editor/serialize'
import { useChatStore, useTextDraftStore, ChatStoreProvider } from '../../../../apps/desktop/src/store/chatContext'
import { chat, chatStore, clickElement } from '../../../support/testHarness'
import { setComposerVerb, takeComposerCarry } from '../../../../apps/desktop/src/lib/composerVerbBridge'
import { ChatLineScope } from '../../../../apps/desktop/src/store/chatLineScope'
import { ShareIntakeContent } from '../../../../apps/desktop/src/mobile/share-intake/ShareIntakeSheet'
import { landPendingStarters } from '../../../../apps/desktop/src/lib/starterContinuation'
import { AssistantChatSlot } from '../../../../apps/desktop/src/components/assistant/AssistantChatSlot'
import { installAssistantShellBridge, readAssistantShellBridge } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { MobileAssistantApp } from '../../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import { i18n } from '../../../../apps/desktop/src/i18n'
import { InChatSlot } from '../../../../apps/desktop/src/lib/shellSlots'

let harness: ReturnType<typeof createReactHarness>
const input = () => harness.container.querySelector<HTMLElement>('[data-testid="chat-composer"]')!
type Editor = { commands: { setContent(content: ReturnType<typeof plainTextDoc>, options: { emitUpdate: boolean }): void }; state: { doc: Parameters<typeof serializeDoc>[0] } }
const editor = () => (input() as HTMLElement & { editor: Editor }).editor
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); setComposerVerb('chat', null); takeComposerCarry('chat') })

let store: ReturnType<typeof useChatStore>
function Actions() { store = useChatStore(); return null }
async function renderComposer(onSend = vi.fn(async () => {})) {
  await renderWithAppProviders(harness, <><Actions /><ChatMessageComposer chatId="chat" onSend={onSend} /></>)
}
async function send() {
  await act(async () => { harness.container.querySelector<HTMLButtonElement>('[data-slot="composer-bar"] button[aria-label="发送消息"]')!.click() })
}

describe('chat editor draft writes', () => {
  it('keeps editor input that advances after React renders but before passive effects run', async () => {
    let advance!: () => void
    function LaterInput({ pending }: { pending: boolean }) {
      useLayoutEffect(() => {
        if (pending) editor().commands.setContent(plainTextDoc('ni hao'), { emitUpdate: false })
      }, [pending])
      return null
    }
    function Fixture() {
      const [pending, setPending] = useState(false)
      advance = () => setPending(true)
      return <><ChatMessageComposer chatId="chat" onSend={async () => {}} /><LaterInput pending={pending} /></>
    }
    await renderWithAppProviders(harness, <Fixture />)
    await act(async () => { writeComposer(input(), 'ni ha'); advance() })
    expect(readComposer(input())).toBe('ni hao')
  })

  it('inserts multiline program content after live unsaved input without replacing its mention nodes', async () => {
    await renderComposer()
    await act(async () => { store.writeDraft('chat', 'draft @[document](gugu-file://0c000000-0000-4000-8000-0000000000a1?v=7)') })
    const before = readComposer(input())
    const mention = editor().state.doc.firstChild!.lastChild!
    await act(async () => { store.writeDraft('chat', { at: 'end', text: 'App line 1\nApp line 2' }) })
    expect(readComposer(input())).toBe(`${before}\nApp line 1\nApp line 2`)
    expect(editor().state.doc.firstChild!.lastChild).toBe(mention)
    expect(mention.type.name).toBe('mention')
  })

  it('clears the live editor as soon as an accepted send begins', async () => {
    const onSend = vi.fn(async () => {})
    await renderComposer(onSend)
    await act(async () => { writeComposer(input(), 'send this') })
    await send()
    expect(onSend).toHaveBeenCalledWith('send this', expect.any(Object))
    expect(readComposer(input())).toBe('')
  })

  it('prepends a failed send to newer live typing instead of replacing the document', async () => {
    let reject!: (reason: Error) => void
    await renderComposer(vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail })))
    await act(async () => { writeComposer(input(), 'original') })
    await send()
    await act(async () => { writeComposer(input(), 'newer'); reject(new Error('send refused')) })
    expect(readComposer(input())).toBe('original\nnewer')
  })

  it('returns the new-task draft directly to the editor when the task is cancelled', async () => {
    await renderComposer()
    await act(async () => { setComposerVerb('chat', 'task') })
    await act(async () => { setComposerVerb('chat', null, 'returned task text') })
    expect(readComposer(input())).toBe('returned task text')
  })

  it('carries the current document into a new task and clears it through the shared writer', async () => {
    await renderWithAppProviders(harness, <InChatSlot.Provider value={{ projectName: null }}><ChatMessageComposer chatId="chat" isGroupChat onSend={async () => {}} /></InChatSlot.Provider>)
    await act(async () => { writeComposer(input(), 'React snapshot') })
    await act(async () => { editor().commands.setContent(plainTextDoc('current document'), { emitUpdate: false }) })
    await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="composer-verb-task"]')!)
    expect(takeComposerCarry('chat')).toBe('current document')
    expect(readComposer(input())).toBe('')
  })

  it('hydrates closed-chat writes once and preserves each chat on switching', async () => {
    let choose!: (chatId: string) => void
    function Host() {
      const drafts = useTextDraftStore()
      const [base] = useState(chatStore)
      const [chatId, setChatId] = useState('chat')
      choose = setChatId
      return <ChatStoreProvider value={{ ...base, ...drafts }}><Actions /><ChatMessageComposer chatId={chatId} onSend={async () => {}} /></ChatStoreProvider>
    }
    await renderWithAppProviders(harness, <Host />)
    await act(async () => { store.writeDraft('other', 'closed draft'); writeComposer(input(), 'unflushed input') })
    await act(async () => { choose('other') })
    expect(readComposer(input())).toBe('closed draft')
    await act(async () => { store.writeDraft('other', { at: 'end', text: 'inserted' }); choose('chat') })
    expect(readComposer(input())).toBe('unflushed input')
    await act(async () => { choose('other') })
    expect(readComposer(input())).toBe('closed draft\ninserted')
  })

  it('reuses the account writer inside a scoped group or assistant conversation', async () => {
    let scoped!: ReturnType<typeof useChatStore>
    function ScopeActions() { scoped = useChatStore(); return null }
    await renderWithAppProviders(harness, <><Actions /><ChatLineScope chatId="chat"><ScopeActions /><ChatMessageComposer chatId="chat" onSend={async () => {}} /></ChatLineScope></>,
      { chat: { activeChatId: null, activeChat: null, chats: [chat({ id: 'chat', kind: 'group' })] } })
    expect(scoped.activeChatId).toBe('chat')
    expect(scoped.activeChat?.id).toBe('chat')
    expect(store.activeChatId).toBeNull()
    await act(async () => { writeComposer(input(), 'unsaved'); store.writeDraft('chat', { at: 'end', text: 'from outside the scope' }) })
    expect(readComposer(input())).toBe('unsaved\nfrom outside the scope')
  })

  it('appends a phone share to live input instead of the older persisted draft', async () => {
    const shared = new File(['shared'], 'shared.txt')
    const onDone = vi.fn()
    await renderWithAppProviders(harness, <><Actions /><ChatMessageComposer chatId="chat" onSend={async () => {}} />
      <ShareIntakeContent share={{ text: 'shared text', files: [shared], failures: [] }} onDone={onDone} /></>,
    { chat: { chats: [chat({ id: 'chat', name: 'Share target', kind: 'group' })], drafts: { chat: 'old snapshot' } } })
    await act(async () => { writeComposer(input(), 'live phone input') })
    const target = [...harness.container.querySelectorAll<HTMLElement>('[role="button"], button')].find((button) => button.textContent?.includes('Share target'))!
    await clickElement(target)
    expect(readComposer(input())).toBe('live phone input\nshared text')
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('lands a pending starter directly into a mounted editor and consumes its durable pointer', async () => {
    await renderComposer()
    const key = 'gugu:agent-provision:starter:owner'
    window.localStorage.setItem(key, JSON.stringify([{ version: 1, ownerUserId: 'owner', operationId: 'operation', groupChatId: 'chat', starter: '  opening task  ' }]))
    await act(async () => { await landPendingStarters(store.writeDraft, async () => 'owner') })
    expect(readComposer(input())).toBe('  opening task  ')
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('appends a desktop assistant request through the same writer used outside its chat scope', async () => {
    installAssistantShellBridge()
    readAssistantShellBridge()!.takeChatDraft()
    await renderWithAppProviders(harness, <><ChatMessageComposer chatId="chat" onSend={async () => {}} />
      <AssistantChatSlot dm={{ chatId: 'chat', failed: null, retry: () => {} }} assistantId="assistant" assistantName="Assistant" visible={false} /></>)
    await act(async () => { writeComposer(input(), 'human draft'); readAssistantShellBridge()!.fillChatDraft('assistant request') })
    expect(readComposer(input())).toBe('human draft\nassistant request')
  })

  it('appends the phone assistant health-report request without replacing live human text', async () => {
    await renderWithAppProviders(harness, <><ChatMessageComposer chatId="chat" onSend={async () => {}} />
      <MobileAssistantApp chatId="chat" assistant={{ id: 'assistant', display_name: 'Assistant', avatar: null, created_at: null }}
        ownerName="Owner" homeDeviceId={null} cloudDeviceId={null} home={null} visible={false} chatRequest={0} /></>)
    await act(async () => { writeComposer(input(), 'phone draft') })
    const upload = harness.container.querySelector<HTMLInputElement>('[data-testid="mobile-assistant-health-report-input"]')!
    await act(async () => {
      Object.defineProperty(upload, 'files', { value: [new File(['report'], 'report.pdf', { type: 'application/pdf' })] })
      upload.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(readComposer(input())).toBe(`phone draft\n${i18n.t('health.healthReportMessage', { ns: 'assistant' })}`)
  })
})
