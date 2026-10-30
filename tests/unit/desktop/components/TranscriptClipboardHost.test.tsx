// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatCommands, ChatContext, ChatState, ChatViewOptions } from '@gugu/session-chat-ui'
import { ChatTranscript, loadChatUi } from '@/session/renderer/lib/chat/chat-transcript'
import { platform } from '@/platform'
import { createNode, createReactHarness } from '../../../support/testHarness'

const mock = vi.hoisted(() => ({
  created: undefined as ChatCommands | undefined,
  current: undefined as ChatCommands | undefined,
  setCommands: vi.fn((commands: ChatCommands) => { mock.current = commands }),
}))
vi.mock('@gugu/session-chat-ui', () => ({ createChatView: (options: ChatViewOptions) => {
  mock.created = options.commands; mock.current = options.commands
  return { setCommands: mock.setCommands, setModel: () => {}, setContentPadding: () => {}, dispose: () => {} }
} }))
let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); vi.restoreAllMocks(); mock.setCommands.mockClear() })

describe('transcript host clipboard capability', () => {
  it('injects the platform at creation and after command replacement without losing other host actions', async () => {
    await loadChatUi()
    harness = createReactHarness()
    const write = vi.spyOn(platform, 'writeClipboardText').mockResolvedValue(undefined)
    const reply = vi.fn(), attachment = vi.fn(), nextReply = vi.fn()
    const context = {} as ChatContext, state = {} as ChatState
    await harness.render(createNode(ChatTranscript, { context, state, commands: { onConversationReply: reply, onViewAttachment: attachment } }))
    expect(mock.created?.writeClipboardText).toBeTypeOf('function')
    await mock.created!.writeClipboardText!('initial 中文\ncode')
    expect(write).toHaveBeenLastCalledWith('initial 中文\ncode')
    expect(mock.created!.onViewAttachment).toBe(attachment)
    await harness.render(createNode(ChatTranscript, { context, state, commands: { onConversationReply: nextReply, onViewAttachment: attachment } }))
    await mock.current!.writeClipboardText!('updated')
    expect(write).toHaveBeenLastCalledWith('updated')
    expect(mock.current!.onConversationReply).toBe(nextReply)
    expect(mock.current!.onViewAttachment).toBe(attachment)
  })
  it('propagates the original platform failure for the shared component error outlet', async () => {
    await loadChatUi(); harness = createReactHarness()
    const error = new Error('native denied')
    vi.spyOn(platform, 'writeClipboardText').mockRejectedValue(error)
    await harness.render(createNode(ChatTranscript, { context: {} as ChatContext, state: {} as ChatState }))
    expect(mock.current?.writeClipboardText).toBeTypeOf('function')
    await expect(mock.current!.writeClipboardText!('refused')).rejects.toBe(error)
    expect(mock.current!.onCopyError).toBeTypeOf('function')
  })
})
