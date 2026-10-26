// @vitest-environment jsdom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { ChatStoreProvider, useChatStore, useTextDraftStore } from '../../../../apps/desktop/src/store/chatContext'
import { chatStore, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { readComposer, writeComposer } from '../../../support/composerEditor'

let harness: ReturnType<typeof createReactHarness>
let store: ReturnType<typeof useChatStore>
function Actions() { store = useChatStore(); return null }
function Host() {
  const drafts = useTextDraftStore()
  const [base] = useState(chatStore)
  return <ChatStoreProvider value={{ ...base, ...drafts }}><Actions />
    <section id="assistant"><ChatMessageComposer chatId="assistant" onSend={async () => {}} /></section>
    <section id="task"><ChatMessageComposer chatId="task" onSend={async () => {}} /></section>
  </ChatStoreProvider>
}
const input = (id: string) => harness.container.querySelector<HTMLElement>(`#${id} [data-testid="chat-composer"]`)!
beforeEach(async () => {
  vi.useFakeTimers()
  harness = createReactHarness()
  await renderWithAppProviders(harness, <Host />)
})
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

describe('two simultaneous conversation drafts', () => {
  it('keeps unsaved typing when the other pane saves, then persists each pane separately', async () => {
    await act(async () => { writeComposer(input('assistant'), '左侧草稿'); vi.advanceTimersByTime(150) })
    await act(async () => { writeComposer(input('task'), '右侧草稿'); vi.advanceTimersByTime(150) })
    expect(readComposer(input('task'))).toBe('右侧草稿')
    await act(async () => { vi.advanceTimersByTime(150) })
    expect(store.drafts).toEqual({ assistant: '左侧草稿', task: '右侧草稿' })
  })
  it('routes an external write to its live editor without overwriting the other pane', async () => {
    await act(async () => { writeComposer(input('task'), '未保存的字'); store.writeDraft('assistant', '来自助理页的建议') })
    expect(readComposer(input('task'))).toBe('未保存的字')
    expect(readComposer(input('assistant'))).toBe('来自助理页的建议')
  })
})
