// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, chat, clickElement, displayIdentity } from '../../../support/testHarness'
import { ChatRowContextMenu } from '../../../../apps/desktop/src/components/chat/ChatRowContextMenu'
const scope = vi.hoisted(() => ({ identitiesById: {} as Record<string, ReturnType<typeof displayIdentity>>, settings: vi.fn() }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ chats: [], identitiesById: scope.identitiesById }) }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../../../../apps/desktop/src/hooks/useMarkChatsRead', () => ({ useMarkChatsRead: () => vi.fn() }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/components/chat/useGroupChatSettings', () => ({ useGroupChatSettings: scope.settings }))
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: (_kind: string, options: { option: { defaultChecked: boolean }; onSuccess: (result: { optionChecked: boolean }) => void }) => options.onSuccess({ optionChecked: options.option.defaultChecked }) }))
let harness: ReturnType<typeof createReactHarness>
const onHide = vi.fn(async () => {})
const removal = () => document.querySelector<HTMLElement>('[data-testid="conversation-row-delete-chat"]')
const render = (kind: 'dm' | 'ai' | 'group' | 'topic' = 'dm') => harness.render(<ChatRowContextMenu chat={chat({ id: 'chat', kind, peer_user_id: 'agent' })} x={40} y={40} onClose={vi.fn()} onPin={vi.fn()} onSetNotificationLevel={vi.fn()} onHide={onHide} />)
beforeEach(() => {
  harness = createReactHarness(); onHide.mockClear(); scope.settings.mockClear()
  scope.identitiesById = { agent: displayIdentity('agent', { type: 'agent', owner_user_id: 'owner', session_archived_at: null, removed_at: null }) }
})
afterEach(() => { harness.cleanup() })
it.each(['dm', 'ai', 'group', 'topic'] as const)('offers personal removal for %s without group-management dependencies', async (kind) => {
  await render(kind)
  expect(removal()?.textContent).toContain('从列表删除')
  await clickElement(removal()!)
  await vi.waitFor(() => expect(onHide).toHaveBeenCalledOnce())
  expect(scope.settings).not.toHaveBeenCalled()
})
it.each([{ type: 'human' as const, owner_user_id: null }, { type: 'agent' as const, owner_user_id: 'another-owner' }])('also hides human and foreign-Agent conversations', async (identity) => {
  scope.identitiesById.agent = displayIdentity('agent', identity)
  await render(); await clickElement(removal()!)
  await vi.waitFor(() => expect(onHide).toHaveBeenCalledOnce())
})
