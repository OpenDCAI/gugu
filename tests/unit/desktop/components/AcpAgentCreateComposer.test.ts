// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { createNode, createReactHarness, clickElement, waitForCondition } from '../../../support/testHarness'
import { AcpAgentCreateComposer } from '../../../../apps/desktop/src/components/AcpAgentCreateComposer'

const mocks = vi.hoisted(() => ({
  provisionSingleAgent: vi.fn(),
  resumeSingleAgent: vi.fn(),
  sendMessage: vi.fn(),
  sendFileToChat: vi.fn(),
  refreshChats: vi.fn(),
  refreshMessages: vi.fn(),
  refreshContacts: vi.fn(),
  setActiveChatId: vi.fn(),
  upsertChat: vi.fn(),
  openCreatedAgentConversation: vi.fn(),
  toast: vi.fn(),
  // What the "type here" control puts into the editor. Tests set it to drive a second,
  // different utterance through the same composer.
  composerInput: 'Handle issue 3195',
  // The real translate fn this assembly hands the shared composer; captured so a test can
  // ask it for the keys the controls it wires will actually request.
  capturedTranslate: null as null | ((key: string, values?: Readonly<Record<string, string | number>>) => string),
}))

// The real composer is a Tiptap editor that CLEARS ITSELF before it hands the text to
// onSubmit (packages/session-ui/.../prompt-editor.tsx: clearContent(true) then onSubmit(text)).
// This mock reproduces that ordering, because a mock that keeps the text on screen cannot
// observe input being dropped — the exact defect #3573 is about.
vi.mock('@gugu/session-ui/react/components', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  const MockComposer = (props: {
    canSubmit: boolean
    onSubmit: (text: string) => void
    onInputChange: (text: string) => void
    onFilesDropped?: (files: File[]) => void
    attachments?: Array<{ id: string }>
    editorApiRef?: { current: unknown }
    toolbarExtra?: ReactNode
  }) => {
    const [text, setText] = React.useState('')
    const textRef = React.useRef('')
    textRef.current = text
    const write = (next: string) => {
      textRef.current = next
      setText(next)
      props.onInputChange(next)
    }
    if (props.editorApiRef) {
      props.editorApiRef.current = {
        focus: () => {},
        clear: () => write(''),
        getText: () => textRef.current,
        setText: (next: string) => write(next),
        insertMention: () => {},
        prependMention: () => {},
        removeMention: () => {},
        setMentionPending: () => {},
      }
    }
    return React.createElement(
      'div',
      null,
      props.toolbarExtra,
      React.createElement('span', { 'data-testid': 'mock-editor-text' }, text),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'mock-session-composer-input',
        onClick: () => write(mocks.composerInput),
      }, 'input'),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'mock-session-composer-file',
        onClick: () => props.onFilesDropped?.([
          new File(['remote bytes'], 'remote.txt', { type: 'text/plain' }),
        ]),
      }, 'file'),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'mock-session-composer-send',
        disabled: !props.canSubmit,
        onClick: () => {
          const submitted = textRef.current
          if (!submitted.trim() && (props.attachments?.length ?? 0) === 0) return
          write('')
          props.onSubmit(submitted)
        },
      }, 'send'),
    )
  }
  return {
    MessageProvider: ({ children, translate }: {
      children: ReactNode
      translate?: (key: string, values?: Readonly<Record<string, string | number>>) => string
    }) => {
      mocks.capturedTranslate = translate ?? null
      return children
    },
    ChatComposer: MockComposer,
    // ⚠️ 这份 mock **整体替换**了那个入口,所以被测组件用到的每一个具名导出都得在这儿列出来 ——
    // 少一个不会让哪条断言变红,而是抛一条 unhandled error:测试照样报「全过」,进程退 1。
    // (#5269 实撞:组件新 import 了 formatAttachmentSize,CI 上 680 个文件 passed 却整步判红。)
    formatAttachmentSize: (bytes: number) => `${bytes} B`,
    // 附件预览那一格(#5269):chip 点开的对话框,以及入列时读文本内容的那一步。
    AttachmentViewerDialog: () => null,
    readAttachmentPreviewText: async () => undefined,
  }
})

vi.mock('@gugu/session-ui/react/primitives', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values?.name ? `${key}:${values.name}` : key,
  }),
}))

vi.mock('../../../../apps/desktop/src/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/i18n')>(),
  useLocale: () => ({ resolvedLocale: 'zh-CN' }),
  setLocalePreference: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../../apps/desktop/src/store/theme', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

vi.mock('../../../../apps/desktop/src/store/auth', () => ({
  useAuth: () => ({ user: { id: 'owner-1', nickname: 'Owner' } }),
}))

vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({
    refreshChats: mocks.refreshChats,
    refreshMessages: mocks.refreshMessages,
    setActiveChatId: mocks.setActiveChatId,
    upsertChat: mocks.upsertChat,
  }),
}))

vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({
  useContactsStore: () => ({ contacts: [], refreshContacts: mocks.refreshContacts }),
}))

vi.mock('../../../../apps/desktop/src/lib/contacts', () => ({
  contactsService: { getContacts: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    sendMessage: mocks.sendMessage,
  },
}))

vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', () => ({ sendFileToChat: mocks.sendFileToChat }))
vi.mock('../../../../apps/desktop/src/lib/deviceFs', () => ({
  deviceFsListDirectory: vi.fn(),
}))

vi.mock('../../../../apps/desktop/src/lib/agentDefaultName', () => ({
  resolveAgentDefaultName: vi.fn().mockResolvedValue('Claude Code 1'),
}))

vi.mock('../../../../apps/desktop/src/lib/agentCreationLifecycle', () => ({
  openCreatedAgentConversation: mocks.openCreatedAgentConversation,
}))

// Capability lookup is optional for legacy providers in these composer tests. Returning no
// startup prompt capability keeps the existing post-provision delivery path under test.
// The model menu asks the chosen machine (rpcOn → sessionTimeline.sessionCreateModels); these tests do not
// exercise it, so it answers "unavailable" and the menu stays in its failed state.
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({
  rpc: { agents: { get: vi.fn().mockResolvedValue(null) } },
  rpcOn: () => ({
    sessionTimeline: { sessionCreateModels: vi.fn().mockResolvedValue({ ok: false, error: { code: 'unavailable', message: 'not in this test' } }) },
  }),
}))

vi.mock('../../../../apps/desktop/src/lib/agentProvision', () => ({
  provisionSingleAgent: mocks.provisionSingleAgent,
  resumeSingleAgent: mocks.resumeSingleAgent,
  completedSingleProvisionSession: () => ({
    chatId: 'dm-3195',
    commandId: 'command-3195',
    agent: { id: 'agent-3195', display_name: 'Claude Code 1', avatar: null },
  }),
}))

vi.mock('../../../../apps/desktop/src/components/ui/Menu', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    DropdownMenu: {
      Root: ({ children }: { children: ReactNode }) => children,
      Trigger: (props: Record<string, unknown>) => React.createElement('button', props),
      Content: ({ children }: { children: ReactNode }) => children,
    Item: ({ children, onClick, ...props }: {
      children: ReactNode
      onClick?: () => void
      disabled?: boolean
      'data-device-id'?: string
    }) => React.createElement(
      'button',
      { type: 'button', ...props, onClick: props.disabled ? undefined : onClick },
      children,
    ),
    },
  }
})

vi.mock('../../../../apps/desktop/src/components/RemoteFolderPicker', () => ({
  RemoteFolderPicker: () => null,
}))

vi.mock('../../../../apps/desktop/src/components/ui/Sheet', () => ({
  Sheet: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({
  useToast: () => ({ toast: mocks.toast }),
}))

describe('AcpAgentCreateComposer', () => {
  const harness = createReactHarness()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.composerInput = 'Handle issue 3195'
    mocks.provisionSingleAgent.mockResolvedValue({
      operationId: 'operation-3195',
      provisionId: 'provision-3195',
      outcome: { member: { phase: 'completed' } },
    })
    mocks.sendMessage.mockResolvedValue({ id: 'message-3195' })
    mocks.sendFileToChat.mockResolvedValue({ id: 'attachment-3195' })
    mocks.refreshChats.mockResolvedValue(undefined)
    mocks.refreshMessages.mockResolvedValue(undefined)
    mocks.refreshContacts.mockResolvedValue(undefined)
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000003195')
  })

  afterEach(() => {
    harness.cleanup()
    vi.restoreAllMocks()
  })

  it('creates on the selected device/project and hands the ACP first turn to startup', async () => {
    const onCreated = vi.fn()
    await harness.render(createNode(AcpAgentCreateComposer, {
      onCreated,
      context: {
        snapshot: {
          ready: true,
          devices: [{ id: 'device-3195', label: 'Mac Studio', isLocal: false, isOnline: true }],
          selectedDeviceId: 'device-3195',
          selectedProjectId: '/Users/mac1/Projects/gugu',
          projectsAvailable: true,
          blockMessage: null,
        },
        rememberedProjectId: '/Users/mac1/Projects/gugu',
        selectDevice: vi.fn(),
        selectProject: vi.fn(),
        reportAvailableProjects: vi.fn(),
      },
    }))

    const input = harness.container.querySelector('[data-testid="mock-session-composer-input"]') as HTMLButtonElement
    await clickElement(input)
    const send = harness.container.querySelector('[data-testid="mock-session-composer-send"]') as HTMLButtonElement
    expect(send.disabled).toBe(false)
    await clickElement(send)

    expect(mocks.provisionSingleAgent).toHaveBeenCalledWith(
      'device-3195',
      expect.objectContaining({
        agentType: 'claude-code',
        projectPath: '/Users/mac1/Projects/gugu',
        inheritMemory: false,
        historyImportRequired: false,
      }),
      expect.objectContaining({
        onAttemptRecorded: expect.any(Function),
        onOperationAcknowledged: expect.any(Function),
        initialMessage: {
          messageId: '00000000-0000-4000-8000-000000003195',
          text: 'Handle issue 3195',
        },
      }),
    )
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(mocks.openCreatedAgentConversation).toHaveBeenCalledTimes(1)
    expect(mocks.setActiveChatId).toHaveBeenCalledWith('dm-3195')
    expect(onCreated).toHaveBeenCalledWith('dm-3195')
  })

  it('keeps offline device rows visible but unavailable for selection', async () => {
    const selectDevice = vi.fn()
    const localHarness = createReactHarness()
    await localHarness.render(createNode(AcpAgentCreateComposer, {
      onCreated: vi.fn(),
      context: {
        snapshot: {
          ready: true,
          devices: [
            { id: 'device-online', label: 'Mac Studio', isLocal: false, isOnline: true },
            { id: 'device-offline', label: 'MacBook', isLocal: false, isOnline: false },
          ],
          selectedDeviceId: 'device-online',
          selectedProjectId: '/Users/mac1/Projects/gugu',
          projectsAvailable: true,
          blockMessage: null,
        },
        rememberedProjectId: '/Users/mac1/Projects/gugu',
        selectDevice,
        selectProject: vi.fn(),
        reportAvailableProjects: vi.fn(),
      },
    }))

    const online = localHarness.container.querySelector('[data-device-id="device-online"]') as HTMLButtonElement
    const offline = localHarness.container.querySelector('[data-device-id="device-offline"]') as HTMLButtonElement
    expect(online).not.toBeNull()
    expect(offline).not.toBeNull()
    expect(offline.disabled).toBe(true)
    await clickElement(offline)
    expect(selectDevice).not.toHaveBeenCalled()
    await clickElement(online)
    expect(selectDevice).toHaveBeenCalledWith('device-online')
    localHarness.cleanup()
  })

  it('uploads a pathless pasted file before sending the ordinary text message', async () => {
    const onCreated = vi.fn()
    const isolatedHarness = createReactHarness()
    await isolatedHarness.render(createNode(AcpAgentCreateComposer, {
      onCreated,
      context: {
        snapshot: {
          ready: true,
          devices: [{ id: 'device-remote', label: 'Mac Studio', isLocal: false, isOnline: true }],
          selectedDeviceId: 'device-remote',
          selectedProjectId: '/Users/mac1/Projects/gugu',
          projectsAvailable: true,
          blockMessage: null,
        },
        rememberedProjectId: '/Users/mac1/Projects/gugu',
        selectDevice: vi.fn(),
        selectProject: vi.fn(),
        reportAvailableProjects: vi.fn(),
      },
    }))

    await clickElement(isolatedHarness.container.querySelector('[data-testid="mock-session-composer-input"]') as HTMLButtonElement)
    await clickElement(isolatedHarness.container.querySelector('[data-testid="mock-session-composer-file"]') as HTMLButtonElement)
    await clickElement(isolatedHarness.container.querySelector('[data-testid="mock-session-composer-send"]') as HTMLButtonElement)

    expect(mocks.sendFileToChat).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'remote.txt' }),
      { chatId: 'dm-3195', senderId: 'owner-1', toUserIds: ['agent-3195'] },
    )
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledWith('dm-3195')
    isolatedHarness.cleanup()
  })

  // The composer is the only custodian of a draft once the editor hands it over and clears
  // itself, so every failed ordinary send restores the words instead of implying success.
  describe('undelivered ordinary message', () => {
    const createContext = () => ({
      snapshot: {
        ready: true,
        devices: [{ id: 'device-3573', label: 'Mac Studio', isLocal: false, isOnline: true }],
        selectedDeviceId: 'device-3573',
        selectedProjectId: '/Users/mac1/Projects/gugu',
        projectsAvailable: true,
        blockMessage: null,
      },
      rememberedProjectId: '/Users/mac1/Projects/gugu',
      selectDevice: vi.fn(),
      selectProject: vi.fn(),
      reportAvailableProjects: vi.fn(),
    })

    const editorText = (container: HTMLElement): string =>
      container.querySelector('[data-testid="mock-editor-text"]')?.textContent ?? ''

    const control = (container: HTMLElement, name: string): HTMLButtonElement =>
      container.querySelector(`[data-testid="mock-session-composer-${name}"]`) as HTMLButtonElement

    async function renderComposer() {
      const localHarness = createReactHarness()
      const onCreated = vi.fn()
      await localHarness.render(createNode(AcpAgentCreateComposer, {
        onCreated,
        context: createContext(),
      }))
      return { localHarness, onCreated }
    }

    // The shared ChatComposer renders a control only when this assembly wires its prop, and
    // asks `translate` for that control's label. The ACP switch throws on any key it does not
    // know, so wiring a control without its key is not a missing label — it takes the whole
    // create surface down through the error boundary. #3522 wired `onAttach` without
    // `composer.addAttachment` and did exactly that.
    it('translates every label the controls it wires will ask for', async () => {
      const { localHarness } = await renderComposer()
      const translate = mocks.capturedTranslate
      expect(translate, 'the assembly hands its own translate to the shared composer').toBeTypeOf('function')
      for (const key of [
        'composer.agent',
        'composer.searchAgents',
        'composer.agentLocked',
        'composer.sendMessage',
        'composer.addAttachment',
        'composer.viewAttachment',
        'composer.removeAttachment',
        // 预览对话框自己的三条 —— 它和 chip 用的是同一个 translate,少一条就在弹开的那一刻抛。
        'attachmentViewer.title',
        'attachmentViewer.truncated',
        'attachmentViewer.unavailable',
      ]) {
        expect(() => translate!(key, { agentName: 'A', name: 'f.txt' }), `translate(${key}) must not throw`).not.toThrow()
      }
      localHarness.cleanup()
    })

    it('restores the draft when provisioning fails before ordinary send', async () => {
      mocks.composerInput = 'Ship the release notes'
      mocks.provisionSingleAgent.mockRejectedValue(new Error('device went offline'))
      const { localHarness } = await renderComposer()

      await clickElement(control(localHarness.container, 'input'))
      await clickElement(control(localHarness.container, 'send'))
      await waitForCondition(
        () => localHarness.container.querySelector('[data-testid="create-agent-composer-error"]') !== null,
        'the failed creation surfaces its error',
      )

      expect(mocks.sendMessage).not.toHaveBeenCalled()
      expect(editorText(localHarness.container)).toBe('Ship the release notes')
      localHarness.cleanup()
    })

    it('restores the draft when its attachment cannot be sent', async () => {
      mocks.composerInput = 'Read the attached spec'
      mocks.sendFileToChat.mockRejectedValue(new Error('an attachment is at most 25 MiB'))
      const { localHarness } = await renderComposer()

      await clickElement(control(localHarness.container, 'input'))
      await clickElement(control(localHarness.container, 'file'))
      await clickElement(control(localHarness.container, 'send'))
      await waitForCondition(
        () => localHarness.container.querySelector('[data-testid="create-agent-composer-error"]') !== null,
        'the rejected upload surfaces its error',
      )

      // The spec orders attachments before the text, so a refused attachment legitimately
      // blocks the prompt — but it must not consume it.
      expect(mocks.sendMessage).not.toHaveBeenCalled()
      expect(editorText(localHarness.container)).toBe('Read the attached spec')
      localHarness.cleanup()
    })

  })
})
