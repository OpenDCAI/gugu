import { vi } from 'vitest'

export const chatService = {
  getCommonGroupChats: vi.fn(async () => []),
  getGroupCollab: vi.fn(async () => null),
  // Group surfaces read the viewer's authority from the server projection (group_info_as).
  getGroupChatSettings: vi.fn(async (chatId: string) => ({
    id: chatId, public_id: 1, creator_user_id: 'owner', name: 'Group', status: 'active',
    group_prompt: null, default_agent_type: null, join_token: null, description: null, max_members: 100,
    allow_member_invite: false, invite_link_enabled: false, agent_join_approval: false, join_mode: 'approval',
    hide_history: false, avatar_url: null, is_discoverable: false, agent_flood_threshold: null,
    agent_flood_threshold_effective: 5, my_role: 'owner', can_manage: true, can_archive_topic: false, can_dissolve: true,
  })),
  // #886 — needed by ContactRowContextMenu action wiring
  getOrCreateDM: vi.fn(async () => 'dm-created-1'),
}
