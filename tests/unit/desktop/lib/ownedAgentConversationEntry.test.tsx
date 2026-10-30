// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useOwnedAgentConversationEntry } from '../../../../apps/desktop/src/hooks/useOwnedAgentConversationEntry'
import { openOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { APP_SHOW_SESSION_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { installSessionViewRequestBridge, SESSION_VIEW_REQUEST_BRIDGE_KEY } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests'
const scope = vi.hoisted(() => ({
  compose: vi.fn(), open: vi.fn(), lookup: vi.fn(), onOpen: vi.fn(),
  drafts: {} as Record<string, string>, attachments: {} as Record<string, unknown[]>,
  write: vi.fn(), setFiles: vi.fn(), select: vi.fn(), assistant: null as string | null,
  identities: {} as Record<string, ContactUser>, mobile: false,
  contacts: [] as ContactUser[], devices: [] as unknown[], native: true,
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  appendToDraft: (old: string, text: string) => [old, text].filter(Boolean).join('\n'),
  useChatStore: () => ({ drafts: scope.drafts, draftAttachments: scope.attachments, writeDraft: scope.write, setDraftAttachments: scope.setFiles, identitiesById: scope.identities, setActiveChatId: scope.select }),
}))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: scope.devices, phones: [] }) }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => scope.native ? ({ invoke: scope.lookup }) : null }))
vi.mock('../../../../apps/desktop/src/lib/composeDraft', () => ({ composeTaskDraft: scope.compose }))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ openTarget: scope.open }))
vi.mock('../../../../apps/desktop/src/lib/assistantShellBridge', () => ({ readAssistantShellBridge: () => ({ getSnapshot: () => ({ assistant: { id: scope.assistant } }) }) }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: vi.fn() }))
let harness: ReturnType<typeof createReactHarness>
const chats = [{ id: 'dm', kind: 'dm', peer_user_id: 'agent' }] as ChatItem[]
const contacts = [{ id: 'agent', type: 'agent', owner_user_id: 'owner' }] as ContactUser[]
let openEntry: ReturnType<typeof useOwnedAgentConversationEntry>
function Fixture() { openEntry = useOwnedAgentConversationEntry({ ownerId: 'owner', chats, contacts: scope.contacts, mobile: scope.mobile, onOpen: scope.onOpen }); return null }
beforeEach(() => {
  harness = createReactHarness(); vi.clearAllMocks(); scope.drafts = {}; scope.attachments = {}; scope.assistant = null
  scope.identities = {}; scope.contacts = contacts; scope.mobile = false; scope.native = true; scope.devices = []
  scope.lookup.mockResolvedValue({ projectId: 'project', sessionId: 'session', view: 'general', projectionError: null, platformRecovery: null })
  scope.compose.mockResolvedValue(undefined)
})
afterEach(() => { harness.cleanup(); delete (window as unknown as Record<string, unknown>)[SESSION_VIEW_REQUEST_BRIDGE_KEY] })
it('opens the same task from the conversation bridge and leaves the assistant App entrance alone', async () => {
  await harness.render(<Fixture />)
  expect(openOwnedAgentEntry('dm')).toBe(true)
  await vi.waitFor(() => expect(scope.open).toHaveBeenCalledWith({ kind: 'session', projectId: 'project', sessionId: 'session' }))
  expect(scope.onOpen).toHaveBeenCalledOnce()
  expect(scope.select).toHaveBeenCalledWith('dm')
  scope.assistant = 'agent'
  expect(openOwnedAgentEntry('dm')).toBe(false)
})
it('cold-opens the native phone task from committed ownership and the offline device digest before contacts can refresh', async () => {
  scope.contacts = []; scope.identities = { agent: contacts[0]! }; scope.native = false; scope.mobile = true
  scope.devices = [{ device_id: 'host', is_online: false, capabilities: {}, projects: [], session_digest: [{ conversationId: 'session', projectId: 'project', title: 'Task', harness: 'claude', supported: true, agentUserId: 'agent', nativeInputVersion: 1, runtime: 'acp' }] }]
  const shown = vi.fn()
  window.addEventListener(APP_SHOW_SESSION_EVENT, shown)
  try {
    await harness.render(<Fixture />)
    expect(openOwnedAgentEntry('dm')).toBe(true)
    await vi.waitFor(() => expect(shown).toHaveBeenCalled())
    expect((shown.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ deviceId: 'host', session: { conversationId: 'session', runtime: 'acp', nativeInputVersion: 1 } })
    expect(scope.select).toHaveBeenCalledWith('dm')
  } finally { window.removeEventListener(APP_SHOW_SESSION_EVENT, shown) }
})
it('does not override a newer foreign ownership snapshot with the cached identity', async () => {
  scope.identities = { agent: contacts[0]! }
  scope.contacts = [{ ...contacts[0]!, owner_user_id: 'other-owner' }]
  await harness.render(<Fixture />)
  expect(openOwnedAgentEntry('dm')).toBe(false)
  expect(scope.select).not.toHaveBeenCalled()
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

it('keeps the source group selected while resolving a participant, then prepares placement before opening the authorized session', async () => {
  let resolve!: (value: unknown) => void
  scope.lookup.mockImplementation(() => new Promise(value => { resolve = value }))
  const prepare = vi.fn(() => vi.fn())
  installSessionViewRequestBridge(window, { openChat: vi.fn(), prepareGroupSession: prepare })
  await harness.render(<Fixture />)
  expect(openOwnedAgentEntry('dm', 'agent', undefined, 'source-group')).toBe(true)
  expect(scope.select).not.toHaveBeenCalled()
  expect(scope.onOpen).not.toHaveBeenCalled()
  expect(scope.open).not.toHaveBeenCalled()
  resolve({ projectId: 'project', sessionId: 'session', view: 'general', projectionError: null, platformRecovery: null })
  await vi.waitFor(() => expect(scope.open).toHaveBeenCalledOnce())
  expect(prepare).toHaveBeenCalledWith('source-group', expect.objectContaining({ projectId: 'project', sessionId: 'session' }))
  expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(scope.open.mock.invocationCallOrder[0]!)
})

it('retains the group when the participant cannot be resolved instead of showing a new-task page', async () => {
  scope.lookup.mockRejectedValue(new Error('host unavailable'))
  await harness.render(<Fixture />)
  expect(openOwnedAgentEntry('dm', 'agent', undefined, 'source-group')).toBe(true)
  await vi.waitFor(() => expect(scope.lookup).toHaveBeenCalledOnce())
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(scope.onOpen).not.toHaveBeenCalled()
  expect(scope.select).not.toHaveBeenCalled()
  expect(scope.open).not.toHaveBeenCalled()
})

it('opens an owned group participant without an IM conversation or draft key', async () => {
  const prepare = vi.fn(() => vi.fn());
  installSessionViewRequestBridge(window, { openChat: vi.fn(), prepareGroupSession: prepare });
  await harness.render(<Fixture />);
  expect(openEntry(undefined, 'agent', undefined, 'source-group')).toBe(true);
  await vi.waitFor(() => expect(scope.open).toHaveBeenCalledOnce());
  expect(prepare).toHaveBeenCalledOnce();
  expect(scope.select).not.toHaveBeenCalled();
  expect(scope.write).not.toHaveBeenCalled();
});
