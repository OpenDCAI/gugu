// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { APP_FORWARD_FILES_EVENT, type AppForwardFilesDetail } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * The folder's 「转发」 (`files.forward`): the chat's own forward page, and what it sends — one file card per file for each
 * chat picked (as forwarding several messages sends one each), by reference through attachments/share: no bytes from
 * here, a stored file at the version the folder showed, a text document as its text is now (no version).
 */
const { shareMock, sendMock, bytesMock, dialog } = vi.hoisted(() => ({
  shareMock: vi.fn(async (_file: Extract<AppForwardFilesDetail, { files: unknown }>['files'][number], _chatId: string) => {}),
  sendMock: vi.fn(async (_chatId: string, _files: File[]) => undefined),
  bytesMock: vi.fn(),
  dialog: { props: null as null | { sourceChatId: string; preview: unknown; onForward(ids: string[]): Promise<void>; onClose(): void } },
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {}, getCurrentAuthUserId: async () => 'me', dataClient: {} }))
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', () => ({ attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't' }) }))
vi.mock('@gugu/core/cloud/attachmentsApi', () => ({ shareAttachment: shareMock, forwardAttachment: bytesMock, uploadAttachmentBytes: bytesMock, commitAttachment: bytesMock }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ chats: [], forwardMessage: shareMock, sendAttachmentsToChat: sendMock }) }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'me' } }) }))
vi.mock('react-i18next', async (original) => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string, values?: { count?: number }) => `${key}:${values?.count}` }) }))
vi.mock('../../../../apps/desktop/src/components/chat/ForwardMessageDialog', () => ({
  ForwardMessageDialog: (props: NonNullable<typeof dialog.props>) => { dialog.props = props; return null },
}))
const { ChatFileForwardHost } = await import('../../../../apps/desktop/src/components/chat/ChatFileForwardHost')

const ask = (detail: AppForwardFilesDetail) => act(() => void window.dispatchEvent(new CustomEvent(APP_FORWARD_FILES_EVENT, { detail })))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  dialog.props = null
  shareMock.mockClear()
  sendMock.mockClear()
  bytesMock.mockClear()
})
afterEach(() => harness.cleanup())

describe('ChatFileForwardHost', () => {
  it('a working copy\'s file: what it holds goes to each chat picked as an attachment, no chat left out', async () => {
    await harness.render(createElement(ChatFileForwardHost))
    await ask({ copies: [{ name: 'a.py', bytes: new TextEncoder().encode('x = 1\n') as Uint8Array<ArrayBuffer> }] })
    expect(dialog.props).toMatchObject({ sourceChatId: '', preview: 'a.py' })
    await dialog.props!.onForward(['c1', 'c2'])
    expect(sendMock.mock.calls.map(([chat]) => chat)).toEqual(['c1', 'c2'])
    const [file] = sendMock.mock.calls[0]![1]
    expect([file!.name, await file!.text()]).toEqual(['a.py', 'x = 1\n'])
    expect(shareMock).not.toHaveBeenCalled()
  })

  it('nothing until a page asks; then the forward page, leaving out the folder\'s own chat', async () => {
    await harness.render(createElement(ChatFileForwardHost))
    expect(dialog.props).toBeNull()
    await ask({ chatId: 'folder-chat', files: [{ itemId: 'i1', version: 4, name: 'deck.pptx', document: false }] })
    expect(dialog.props).toMatchObject({ sourceChatId: 'folder-chat', preview: 'deck.pptx' })
  })

  it('N files to M chats: N×M file cards by reference — the version shown for a stored file, none for a document; no bytes sent', async () => {
    await harness.render(createElement(ChatFileForwardHost))
    await ask({ chatId: 'folder-chat', files: [
      { itemId: 'i1', version: 4, name: 'deck.pptx', document: false },
      { itemId: 'i2', version: 2, name: '周报', document: true },
    ] })
    expect(dialog.props!.preview).toBe('forward.filesPreview:2')
    await dialog.props!.onForward(['c1', 'c2'])
    expect(shareMock.mock.calls.map(([file, target]) => [file.itemId, file.document ? null : file.version, target])).toEqual([
      ['i1', 4, 'c1'], ['i1', 4, 'c2'], ['i2', null, 'c1'], ['i2', null, 'c2'],
    ])
    expect(bytesMock).not.toHaveBeenCalled()
  })
})
