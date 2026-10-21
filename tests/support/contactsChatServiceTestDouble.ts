import { vi } from 'vitest'

export const chatService = {
  getCommonGroupChats: vi.fn(async () => []),
  getGroupCollab: vi.fn(async () => null),
  // #886 — needed by ContactRowContextMenu action wiring
  getOrCreateDM: vi.fn(async () => 'dm-created-1'),
}
