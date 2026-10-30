// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { newDocument } from '../../../../apps/desktop/src/components/imageAnnotate/annotateModel'
import { useAnnotateSend } from '../../../../apps/desktop/src/components/imageAnnotate/useAnnotateSend'
import { AnnotateSendBar } from '../../../../apps/desktop/src/components/imageAnnotate/AnnotateSendBar'
import zh from '../../../../apps/desktop/src/i18n/locales/zh-CN/main'
import type { ImageViewerItem } from '../../../../apps/desktop/src/lib/imageViewer'
import type { MessageItem } from '@gugu/core/shared/types/chat'

const calls = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), compose: vi.fn(), session: vi.fn(), done: vi.fn(), t: vi.fn(), store: {} as Record<string, unknown> }))
vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: calls.t }) }))
vi.mock('@/lib/chat', () => ({ chatService: { getMessageById: calls.read } }))
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: calls.session }))
vi.mock('@/session/shared/extensions/app-send-core', () => ({ composeInChat: calls.compose }))
vi.mock('@/store/chatContext', () => ({ useChatStore: () => calls.store }))
vi.mock('@/components/toastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }))
vi.mock('@/lib/imageClipboard', () => ({ writeImageBlobToClipboard: vi.fn() }))

let harness: ReturnType<typeof createReactHarness>
let actions: ReturnType<typeof useAnnotateSend>
const item: ImageViewerItem = { url: 'blob:original', alt: 'image.png', source: { chatId: 'group', messageId: 'original' } }
const doc = newDocument(1200, 800)
const output = async () => Object.assign(new Blob(['png'], { type: 'image/png' }), { arrayBuffer: async () => new ArrayBuffer(3) })
function Probe({ image = item }: { image?: ImageViewerItem }) {
  actions = useAnnotateSend(image, doc, output, calls.done)
  return <div className="ia-editor"><AnnotateSendBar actions={actions} /></div>
}
function message(overrides: Partial<MessageItem> = {}): MessageItem {
  return { id: 'original', chat_id: 'group', sender_user_id: 'peer', to_user_ids: ['me'], is_whisper: true, ...overrides } as MessageItem
}
beforeEach(() => {
  vi.clearAllMocks()
  calls.t.mockImplementation((key: keyof typeof zh.imageAnnotate, data?: Record<string, string>) => {
    const value = zh.imageAnnotate[key]
    return typeof value === 'string' ? value.replace(/{{(\w+)}}/g, (_, name) => data?.[name] ?? '') : key
  })
  calls.store = { chats: [{ id: 'group', name: '实际群', kind: 'group' }], identitiesById: { peer: { display_name: '咕咕' } }, conversations: { actions: () => ({ sendAttachments: calls.send }) } }
  calls.session.mockReturnValue({ access_token: 'test-token', user: { id: 'me' } })
  calls.read.mockResolvedValue(message())
  calls.compose.mockResolvedValue({ chatId: 'group', text: '' })
  calls.send.mockResolvedValue(undefined)
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup() })

describe('annotation reply destination', () => {
  it.each([
    { direction: 'incoming', source: { sender_user_id: 'peer', to_user_ids: ['me'] } },
    { direction: 'outgoing', source: { sender_user_id: 'me', to_user_ids: ['peer'] } },
  ])('labels an $direction whisper with its actual peer, and sends privately to that same peer', async ({ source }) => {
    calls.read.mockResolvedValue(message(source))
    await harness.render(createNode(Probe))
    expect(harness.container.textContent).toContain('悄悄话发送给 咕咕')
    expect(harness.container.textContent).not.toContain('发送到「实际群」')
    await act(async () => { await actions.send() })
    expect(calls.send).toHaveBeenCalledWith([expect.any(File)], expect.objectContaining({ replyToMessageId: 'original', isWhisper: true, toUserIds: ['peer'] }))
    expect(calls.done).toHaveBeenCalledOnce()
  })
  it('keeps the normal group label and public delivery for a public source', async () => {
    calls.read.mockResolvedValue(message({ is_whisper: false, to_user_ids: [] }))
    await harness.render(createNode(Probe))
    expect(harness.container.textContent).toContain('发送到「实际群」')
    expect(harness.container.textContent).not.toContain('悄悄话发送给')
    await act(async () => { await actions.send() })
    expect(calls.send).toHaveBeenCalledWith([expect.any(File)], expect.objectContaining({ isWhisper: false, toUserIds: [] }))
  })
  it.each([
    { kind: 'dm', chat: { id: 'group', name: '', kind: 'dm', peer_user_id: 'peer' }, label: '发送到「咕咕」' },
    { kind: 'group', chat: { id: 'group', name: '实际群', kind: 'group' }, label: '发送到「实际群」' },
  ])('names a public $kind destination the way the chat list does', async ({ chat, label }) => {
    calls.store = { ...calls.store, chats: [chat] }
    calls.read.mockResolvedValue(message({ is_whisper: false, to_user_ids: [] }))
    await harness.render(createNode(Probe))
    expect(harness.container.textContent).toContain(label)
    expect(harness.container.textContent).not.toContain('发送到「」')
  })
  it('uses a neutral reply label until the original is known, and ignores a late read from another image', async () => {
    let resolveOld!: (value: MessageItem) => void
    calls.read.mockReturnValueOnce(new Promise<MessageItem>(resolve => { resolveOld = resolve }))
    await harness.render(createNode(Probe))
    expect(harness.container.textContent).toContain('回复原图')
    expect(harness.container.textContent).not.toContain('发送到「实际群」')
    calls.read.mockResolvedValueOnce(message({ id: 'other', is_whisper: false, to_user_ids: [] }))
    await harness.render(createNode(Probe, { image: { ...item, source: { chatId: 'group', messageId: 'other' } } }))
    await act(async () => resolveOld(message()))
    expect(harness.container.textContent).toContain('发送到「实际群」')
    expect(harness.container.textContent).not.toContain('悄悄话发送给')
  })
  it('rejects a whisper pair that does not contain this sender before composing or sending', async () => {
    calls.read.mockResolvedValue(message({ sender_user_id: 'stranger', to_user_ids: ['peer'] }))
    await harness.render(createNode(Probe))
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('原图消息已无法读取')
    await act(async () => { await actions.send() })
    expect(calls.compose).not.toHaveBeenCalled()
    expect(calls.send).not.toHaveBeenCalled()
    expect(calls.done).not.toHaveBeenCalled()
  })
  it('shows the actual source read error and never presents an unreadable original as public', async () => {
    calls.read.mockRejectedValue(new Error('source access denied'))
    await harness.render(createNode(Probe))
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('source access denied')
    expect(harness.container.textContent).toContain('回复原图')
    expect(harness.container.textContent).not.toContain('发送到「实际群」')
  })
})
