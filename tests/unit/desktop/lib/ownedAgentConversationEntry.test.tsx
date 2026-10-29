// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useOwnedAgentConversationEntry } from '../../../../apps/desktop/src/hooks/useOwnedAgentConversationEntry'
import { openOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
const scope = vi.hoisted(() => ({
  compose: vi.fn(), open: vi.fn(), lookup: vi.fn(), onOpen: vi.fn(),
  drafts: {} as Record<string, string>, attachments: {} as Record<string, unknown[]>,
  write: vi.fn(), setFiles: vi.fn(), assistant: null as string | null,
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  appendToDraft: (old: string, text: string) => [old, text].filter(Boolean).join('\n'),
  useChatStore: () => ({ drafts: scope.drafts, draftAttachments: scope.attachments, writeDraft: scope.write, setDraftAttachments: scope.setFiles }),
}))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [], phones: [] }) }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ({ invoke: scope.lookup }) }))
vi.mock('../../../../apps/desktop/src/lib/composeDraft', () => ({ composeTaskDraft: scope.compose }))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ openTarget: scope.open }))
vi.mock('../../../../apps/desktop/src/lib/assistantShellBridge', () => ({ readAssistantShellBridge: () => ({ getSnapshot: () => ({ assistant: { id: scope.assistant } }) }) }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: vi.fn() }))
let harness: ReturnType<typeof createReactHarness>
const chats = [{ id: 'dm', kind: 'dm', peer_user_id: 'agent' }] as ChatItem[]
const contacts = [{ id: 'agent', type: 'agent', owner_user_id: 'owner' }] as ContactUser[]
function Fixture() { useOwnedAgentConversationEntry({ ownerId: 'owner', chats, contacts, mobile: false, onOpen: scope.onOpen }); return null }
beforeEach(() => {
  harness = createReactHarness(); vi.clearAllMocks(); scope.drafts = {}; scope.attachments = {}; scope.assistant = null
  scope.lookup.mockResolvedValue({ projectId: 'project', sessionId: 'session', view: 'general', projectionError: null, platformRecovery: null })
  scope.compose.mockResolvedValue(undefined)
})
afterEach(() => harness.cleanup())
it('opens the same task from the conversation bridge and leaves the assistant App entrance alone', async () => {
  await harness.render(<Fixture />)
  expect(openOwnedAgentEntry('dm')).toBe(true)
  await vi.waitFor(() => expect(scope.open).toHaveBeenCalledWith({ kind: 'session', projectId: 'project', sessionId: 'session' }))
  expect(scope.onOpen).toHaveBeenCalledOnce()
  scope.assistant = 'agent'
  expect(openOwnedAgentEntry('dm')).toBe(false)
})
it('transfers the old image and caption as one draft only after the target composer accepts them', async () => {
  const image = new File(['plot'], 'plot.png', { type: 'image/png' })
  scope.drafts = { dm: 'old caption' }; scope.attachments = { dm: [{ id: 'image', file: image, kind: 'image' }] }
  let accept!: () => void
  scope.compose.mockImplementation(() => new Promise<void>(resolve => { accept = resolve }))
  await harness.render(<Fixture />)
  openOwnedAgentEntry('dm')
  await vi.waitFor(() => expect(scope.compose).toHaveBeenCalledWith(expect.anything(), 'old caption', false, [image]))
  expect(scope.write).not.toHaveBeenCalled()
  accept()
  await vi.waitFor(() => expect(scope.write).toHaveBeenCalledWith('dm', ''))
  expect(scope.setFiles).toHaveBeenCalledWith('dm', [])
})
it('retains the old draft when its destination cannot accept the attachment', async () => {
  scope.drafts = { dm: 'keep caption' }
  scope.compose.mockRejectedValue(new Error('not ready'))
  await harness.render(<Fixture />)
  openOwnedAgentEntry('dm')
  await vi.waitFor(() => expect(scope.compose).toHaveBeenCalled())
  expect(scope.write).not.toHaveBeenCalled()
})
