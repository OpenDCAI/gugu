// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, chat, clickElement, displayIdentity } from '../../../support/testHarness'
import { ChatRowContextMenu } from '../../../../apps/desktop/src/components/chat/ChatRowContextMenu'

const scope = vi.hoisted(() => ({ identitiesById: {} as Record<string, ReturnType<typeof displayIdentity>>, settings: null as { can_dissolve: boolean } | null }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ chats: [], identitiesById: scope.identitiesById }) }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../../../../apps/desktop/src/hooks/useMarkChatsRead', () => ({ useMarkChatsRead: () => vi.fn() }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/components/chat/useGroupChatSettings', () => ({ useGroupChatSettings: () => ({ settings: scope.settings, error: null }) }))

let harness: ReturnType<typeof createReactHarness>
const onDelete = vi.fn()
const deletion = async () => {
  const more = document.querySelector<HTMLElement>('[data-testid="conversation-row-more"]')
  if (more) await clickElement(more)
  return document.querySelector<HTMLElement>('[data-testid="conversation-row-delete-chat"]')
}
const render = () => harness.render(<ChatRowContextMenu chat={chat({ id: 'dm', kind: 'dm', peer_user_id: 'agent' })} x={40} y={40} onClose={vi.fn()} onPin={vi.fn()} onSetNotificationLevel={vi.fn()} onDelete={onDelete} />)

beforeEach(() => {
  harness = createReactHarness()
  onDelete.mockClear()
  scope.settings = null
  scope.identitiesById = { agent: displayIdentity('agent', { type: 'agent', owner_user_id: 'owner', session_archived_at: null, removed_at: null }) }
})
afterEach(() => { harness.cleanup() })

it('omits Delete for an active owned Agent and follows the projected archive/restore state', async () => {
  await render()
  expect(await deletion()).toBeNull()
  scope.identitiesById.agent.session_archived_at = '2026-11-06T10:00:00Z'
  await render()
  expect(await deletion()).not.toBeNull()
  scope.identitiesById.agent.session_archived_at = null
  await render()
  expect(await deletion()).toBeNull()
  expect(onDelete).not.toHaveBeenCalled()
})

it.each(['session_archived_at', 'removed_at'] as const)('keeps the existing delete action for %s owned Agent DMs', async (field) => {
  scope.identitiesById.agent[field] = '2026-11-06T10:00:00Z'
  await render()
  await clickElement((await deletion())!)
  expect(onDelete).toHaveBeenCalledOnce()
})

it.each([
  { type: 'human' as const, owner_user_id: null },
  { type: 'agent' as const, owner_user_id: 'another-owner' },
])('does not add deletion for human or foreign identities', async (identity) => {
  scope.identitiesById.agent = displayIdentity('agent', { ...identity, session_archived_at: '2026-11-06T10:00:00Z', removed_at: '2026-11-06T10:00:00Z' })
  await render()
  expect(await deletion()).toBeNull()
})

it.each([[true, 1], [false, 0]])('dissolving a group asks first: confirmed %s runs the delete %i time', async (answer, runs) => {
  scope.settings = { can_dissolve: true }
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(answer)
  await harness.render(<ChatRowContextMenu chat={chat({ id: 'g', kind: 'group' })} x={40} y={40} onClose={vi.fn()} onPin={vi.fn()} onSetNotificationLevel={vi.fn()} onDelete={onDelete} />)
  await clickElement((await deletion())!)
  expect(confirm).toHaveBeenCalledOnce()
  expect(onDelete).toHaveBeenCalledTimes(runs)
  confirm.mockRestore()
})
