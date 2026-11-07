// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'
import { useLinkNavigation } from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import { openLinkTarget } from '../../../../apps/desktop/src/lib/guguLinks'
import { useChatOpener } from '../../../../apps/desktop/src/components/appSlot/useChatOpener'
import { askChat, askChatFile, panelTabsOf } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import type { AppOpenWithDetail } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

const state = vi.hoisted(() => ({ chat: '', resolve: vi.fn(), note: vi.fn(), local: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron', capabilities: {} } }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ localFileRevision: state.local }))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({ appsHere: { groupFileOpener: state.resolve } }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {
  rpc: state.note,
  from: () => {
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { chat_id: state.chat }, error: null }) }
    return query
  },
} }))

let serial = 0
let harness: ReturnType<typeof createReactHarness>
const onShow = vi.fn<(_chat: string, _tab: string) => void | Promise<void>>()
function Entry() {
  useLinkNavigation({ ownerId: 'owner', chats: [{ id: state.chat, kind: 'group' }] as never, contacts: [],
    openChat() {}, openAssistant() {}, openApp() {}, openOwnApp() {}, openProject() {},
    openFile: (chat, target, source) => askChatFile(chat, { itemId: target.itemId, ...source }),
  })
  return useChatOpener(state.chat, onShow).overlay
}
function detail(itemId = 'file'): AppOpenWithDetail {
  return { chatId: state.chat, itemId, name: `${itemId}.md`, typedName: `${itemId}.md`,
    choice: { kind: 'one', candidate: { tabKind: 'workspace.file', suffix: '.md' } } } as AppOpenWithDetail
}
function link(itemId = 'file') {
  const opened = openLinkTarget({ kind: 'file', itemId })
  void opened.catch(() => undefined)
  return opened
}
beforeEach(() => {
  harness = createReactHarness()
  state.chat = `file-receipt-1789-${++serial}`
  state.resolve.mockReset(); state.note.mockReset(); state.local.mockReset(); onShow.mockReset()
  state.local.mockResolvedValue(null)
  state.note.mockResolvedValue({ error: null })
})
afterEach(() => harness.cleanup())

it('keeps the real link pending until its file is resolved and its native panel accepts it', async () => {
  let resolveFile!: (value: unknown) => void, showPanel!: () => void
  state.resolve.mockImplementation(() => new Promise(resolve => { resolveFile = resolve }))
  onShow.mockImplementation(() => new Promise<void>(resolve => { showPanel = resolve }))
  await harness.render(<Entry />)
  let outcome = 'pending'
  const opened = link().then(() => { outcome = 'opened' })
  await act(async () => { await until('file resolution started', () => state.resolve.mock.calls.length === 1) })
  expect(outcome).toBe('pending')
  expect(panelTabsOf(state.chat)).toHaveLength(0)
  await act(async () => { resolveFile({ success: true, data: detail() }); await until('native panel was requested', () => onShow.mock.calls.length === 1) })
  expect(outcome).toBe('pending')
  expect(state.note).not.toHaveBeenCalled()
  expect(panelTabsOf(state.chat)[0]?.item.itemId).toBe('file')
  await act(async () => { showPanel(); await opened })
  expect(outcome).toBe('opened')
  await until('the accepted file is recorded as opened', () => state.note.mock.calls.length === 1)
})

it.each(['refused', 'transport rejection'])('returns a file %s to the original link without a duplicate failure surface', async mode => {
  if (mode === 'refused') state.resolve.mockResolvedValue({ success: false, error: 'file disappeared' })
  else state.resolve.mockRejectedValue(new Error('file host disconnected'))
  await harness.render(<Entry />)
  await act(async () => { await expect(link()).rejects.toThrow() })
  expect(harness.container.querySelector('[data-testid="group-app-slot-unopened"]')).toBeNull()
  expect(panelTabsOf(state.chat)).toHaveLength(0)
  expect(onShow).not.toHaveBeenCalled()
  expect(state.note).not.toHaveBeenCalled()
})

it('propagates native placement rejection instead of recording the file as opened', async () => {
  state.resolve.mockResolvedValue({ success: true, data: detail() })
  onShow.mockRejectedValue(new Error('native resource host unavailable'))
  await harness.render(<Entry />)
  await act(async () => { await expect(link()).rejects.toThrow() })
  expect(harness.container.querySelector('[data-testid="group-app-slot-unopened"]')).toBeNull()
  expect(state.note).not.toHaveBeenCalled()
})

it('keeps the inline failure surface for a direct folder request without a link caller', async () => {
  state.resolve.mockResolvedValue({ success: false, error: 'file disappeared' })
  await harness.render(<Entry />)
  await act(async () => {
    askChat(state.chat, { itemId: 'file' })
    window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId: state.chat } }))
  })
  expect(harness.container.querySelector('[data-testid="group-app-slot-unopened"]')).not.toBeNull()
  expect(panelTabsOf(state.chat)).toHaveLength(0)
})

it('takes a cold file request when its consumer mounts without acknowledging the mailbox alone', async () => {
  state.resolve.mockResolvedValue({ success: true, data: detail() })
  let outcome = 'pending'
  const opened = askChatFile(state.chat, { itemId: 'file' }).then(() => { outcome = 'opened' })
  expect(outcome).toBe('pending')
  expect(state.resolve).not.toHaveBeenCalled()
  await harness.render(<Entry />)
  await opened
  expect(outcome).toBe('opened')
  expect(onShow).toHaveBeenCalledOnce()
})

it('rejects an unmounted consumer and ignores its late successful result', async () => {
  let finish!: (value: unknown) => void
  state.resolve.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await harness.render(<Entry />)
  const opened = link()
  await act(async () => { await until('file resolution started', () => state.resolve.mock.calls.length === 1) })
  await harness.render(null)
  await expect(opened).rejects.toThrow()
  await act(async () => { finish({ success: true, data: detail() }) })
  expect(panelTabsOf(state.chat)).toHaveLength(0)
  expect(onShow).not.toHaveBeenCalled()
})

it('does not replace the latest file with an older result or claim the older link succeeded', async () => {
  let finishFirst!: (value: unknown) => void
  state.resolve.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
    .mockResolvedValueOnce({ success: true, data: detail('second') })
  await harness.render(<Entry />)
  const first = link('first')
  await act(async () => { await until('first file resolution started', () => state.resolve.mock.calls.length === 1) })
  await act(async () => { await link('second') })
  await expect(first).rejects.toThrow()
  await act(async () => { finishFirst({ success: true, data: detail('first') }) })
  expect(panelTabsOf(state.chat).map(tab => tab.item.itemId)).toEqual(['second'])
  expect(onShow).toHaveBeenCalledOnce()
})

it('refuses a resolver response for another conversation without opening its file', async () => {
  state.resolve.mockResolvedValue({ success: true, data: { ...detail(), chatId: 'other-chat' } })
  await harness.render(<Entry />)
  await act(async () => { await expect(link()).rejects.toThrow() })
  expect(panelTabsOf(state.chat)).toHaveLength(0)
  expect(onShow).not.toHaveBeenCalled()
})
