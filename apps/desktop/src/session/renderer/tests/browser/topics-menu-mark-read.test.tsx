/**
 * Topics 弹出列表里右键一个话题:已读菜单开在还开着的 Topics 菜单之上。判据是真指针 —— 两层菜单各自的「点外面就关」
 * 只有真的 pointerdown/click 序列才会触发,jsdom 的合成 click 看不到第二层被第一层关掉吞了点击。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import '@/styles/tokens.css'
import '@renderer/index.css'

const markRead = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useMarkChatsRead', () => ({ useMarkChatsRead: () => markRead }))
const topics = vi.hoisted(() => ['new', 'old'].map((id) => ({
  id, kind: 'topic', source_chat_id: 'g', status: 'active', name: `Topic ${id}`, created_at: '2026-11-01T00:00:00Z',
  last_message_at: '2026-11-01T00:00:00Z', last_message_preview: null, unread_count: 3, pinned_message_id: null, last_read_seq: 0, next_message_seq: 4,
})) as unknown as ChatItem[])
vi.mock('@/components/chat/useChatTopicPins', () => ({
  useChatTopicPins: () => ({ topics, pinned: [], others: topics, ready: true, saving: false, error: null, retry: () => {}, set: () => {}, topicIds: [] }),
}))

const { DropdownMenu } = await import('@/components/ui/Menu')
const { GroupTopicsRows } = await import('@/components/chat/GroupTopicsRows')

let root: Root | null = null
afterEach(() => { root?.unmount(); root = null; markRead.mockReset() })

function mount() {
  const host = document.createElement('div')
  host.className = 'gugu-skin'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<DropdownMenu.Root modal={false}>
    <DropdownMenu.Trigger data-testid="topics">Topics</DropdownMenu.Trigger>
    <DropdownMenu.Content style={{ width: 320 }}><GroupTopicsRows chatId="g" /></DropdownMenu.Content>
  </DropdownMenu.Root>)
}

test.each([
  ['conversation-row-mark-read', 'old'],
  ['chat-row-mark-all-read', ['new', 'old']],
])('%s from a topic row in the open Topics menu reaches the read writer', async (item, scope) => {
  mount()
  await userEvent.click(page.getByTestId('topics'))
  const row = page.getByText('Topic old')
  await expect.element(row).toBeVisible()
  await userEvent.click(row, { button: 'right' })
  const action = page.getByTestId(item)
  await expect.element(action).toBeVisible()
  await userEvent.click(action)
  await vi.waitFor(() => expect(markRead).toHaveBeenCalledWith(scope))
  expect(markRead).toHaveBeenCalledTimes(1)
})
