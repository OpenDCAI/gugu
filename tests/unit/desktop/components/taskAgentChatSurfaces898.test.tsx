// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { displayIdentityFromRow } from '../../../../apps/desktop/src/lib/displayIdentity'

const state = vi.hoisted(() => ({ chats: [] as ChatItem[], identitiesById: {} as Record<string, ReturnType<typeof displayIdentityFromRow>> }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => state }))
vi.mock('../../../../apps/desktop/src/hooks/useForwardedSource', () => ({ useForwardedSource: () => ({ chatId: 'source', name: null }) }))
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: (props: { memberAvatars?: Array<{ name: string }> }) => createElement('span', { 'data-avatar-names': props.memberAvatars?.map((member) => member.name).join('|') }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { appName: () => null } }))

import { ChatBlockHead } from '../../../../apps/desktop/src/components/chat/ChatBlockHead'
import { MessageMetaRow } from '../../../../apps/desktop/src/components/chat/MessageMetaRow'

const identity = (id: string, serial: number) => displayIdentityFromRow({
  id, display_name: 'Review', name_serial: serial, type: 'agent', avatar: null, gugu_number: null,
  bio: null, owner_user_id: 'owner', agent_public: true, desired_status: 'online',
  device_id: 'device', category: null, is_official: false, local_path: null, created_at: null, updated_at: null,
})
let container: HTMLDivElement
let title: HTMLDivElement
let root: Root
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  state.identitiesById = { a: identity('a', 2), b: identity('b', 7) }
  state.chats = [{ id: 'source', kind: 'dm', status: 'active', peer_user_id: 'a', name: '', member_user_ids: ['a', 'b'],
    created_at: '2026-10-30T00:00:00Z', last_message_at: null, last_message_preview: null, unread_count: 0,
    pinned_message_id: null, last_read_seq: 0, next_message_seq: 1 }]
  container = document.createElement('div')
  title = document.createElement('div')
  document.body.append(container, title)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); title.remove(); actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment })

describe('chat labels use the shared identity formatter', () => {
  it('passes the same per-chat serial labels to composite member avatars', () => {
    act(() => root.render(createElement(ChatBlockHead, { host: { actions: null, title }, actions: null,
      chat: { ...state.chats[0], kind: 'group' }, name: 'Room', avatar: null, isAgent: false, identitiesById: state.identitiesById })))
    expect(title.querySelector('[data-avatar-names]')?.getAttribute('data-avatar-names')).toBe('Review · 2|Review · 7')
  })

  it('uses the current identity and chat alias for forwarded message metadata', () => {
    const render = () => act(() => root.render(createElement(MessageMetaRow, { targetingLabels: [],
      forwardedFromMessageId: 'message', viaApp: null, viaAppSender: null })))
    render()
    expect(container.textContent).toContain('Review · 2')
    state.identitiesById.a = { ...state.identitiesById.a, display_name: 'Current reviewer' }
    render()
    expect(container.textContent).toContain('Current reviewer')
    expect(container.textContent).not.toContain('Review · 2')
    state.chats[0] = { ...state.chats[0], peer_alias: 'My reviewer' }
    render()
    expect(container.textContent).toContain('My reviewer')
  })
})
