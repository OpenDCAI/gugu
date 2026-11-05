import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { chat, createReactHarness, device, displayIdentity, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { ListRow } from '@/components/ui/ListRow'
import { Avatar } from '@/components/Avatar'
import { NeedsYouTaskRow } from '@/components/needsYou/NeedsYouTaskRow'
import type { NeedsYouTask } from '@/components/needsYou/useNeedsYouTasks'
import { PhoneAssistantRow } from '@/mobile/assistant/PhoneAssistantRow'
import type { PhoneAssistantState } from '@/mobile/assistant/usePhoneAssistant'
import { PhoneProjectChatAvatar } from '@/mobile/partners/PhoneProjectChatAvatar'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'
import '@/mobile/partners/partners.css'
import '@/mobile/assistant/assistant-phone.css'

vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [device('host', [], {
  projects: [{ localProjectId: 'project', chatId: 'project-chat', name: 'task-project', rootPath: '/project', createdAt: '2026-11-02T00:00:00Z', folders: [] }],
})] }) }))
vi.mock('@/hooks/useAgentDisplayStatus', () => ({ useAgentDisplayStatuses: () => ({ codex: 'error' }) }))
// The folder badge reads the project's tasks (the desktop project dot's count): one waits for approval.
vi.mock('@/session/shared/remote-sessions/session-directory', async original => ({
  ...await original<typeof import('@/session/shared/remote-sessions/session-directory')>(),
  useLiveDeviceSessions: () => ({ host: { projects: [], cached: false, loading: false, error: null, sessions: [
    { conversationId: 'waiting', projectId: 'project', title: 'Codex 1', status: { status: 'needs_user', detail: 'approval' }, runtime: 'acp', supported: true, unseen: true },
  ] } }),
}))
vi.mock('@/lib/agentPresenceMobx', async () => {
  const { presentAgentStatus } = await import('@gugu/core/shared/agentStatusPresentation')
  return { observedAgentPresence: () => ({ presentation: presentAgentStatus({ reading: { status: 'needs_user', detail: 'approval' } }) }) }
})

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); delete document.documentElement.dataset.theme })

const waiting: NeedsYouTask = {
  deviceId: 'host', machine: 'Test host', local: false, phoneHost: false,
  session: { conversationId: 'waiting', title: 'Codex 1', agent: { userId: 'codex' }, status: { status: 'needs_user', detail: 'approval' }, runtime: 'acp', supported: true } as NeedsYouTask['session'],
}
const assistant: PhoneAssistantState = { available: true, assistant: null, chatId: null, cloudDeviceId: null,
  homeDeviceId: null, home: null, ownerName: null, stage: { stage: 'onboarding' } as PhoneAssistantState['stage'] }
const projectChat = chat({ id: 'project-chat', kind: 'group', name: 'task-project', member_user_ids: ['codex'] })

it.each(['light', 'dark'].flatMap(theme => [360, 390].map(width => ({ theme, width }))))(
  '$theme $width: message avatar slots, title starts and attention anchors align', async ({ theme, width }) => {
    await page.viewport(width, 844)
    document.documentElement.dataset.theme = theme
    await renderWithAppProviders(harness,
      <div data-phone-shell="" style={{ width, padding: 8 }}><div data-phone-root-list="chats"><div role="listbox">
        <PhoneAssistantRow state={assistant} onOpen={() => {}} />
        <div data-needs-you-list-slot=""><NeedsYouTaskRow task={waiting} onClick={() => {}} onKeyDown={() => {}} /></div>
        <ListRow mobile title="task-project" leading={<PhoneProjectChatAvatar chat={projectChat} mobile><Avatar name="group" variant="group" size={48} /></PhoneProjectChatAvatar>} />
        <ListRow mobile title="ordinary agent" leading={<Avatar name="ordinary agent" seed="codex" size={48} isAgent agentStatus="error" harnessBadge={false} />} />
      </div></div></div>,
      { chat: { identitiesById: { codex: displayIdentity('codex', { type: 'agent', display_name: 'Codex 1' }) } } },
    )
    const rows = [...harness.container.querySelectorAll<HTMLElement>('.gg-list-row')]
    expect(rows).toHaveLength(4)
    const slots = rows.map(row => row.querySelector<HTMLElement>('.gg-list-row-leading')!.getBoundingClientRect())
    const titles = rows.map(row => row.querySelector<HTMLElement>('.gg-list-row-title')!.getBoundingClientRect())
    for (const row of rows) expect(row.getBoundingClientRect().width).toBeGreaterThan(300)
    for (const slot of slots) { expect(slot.width).toBe(48); expect(slot.height).toBe(48); expect(slot.x).toBe(slots[0].x) }
    for (const title of titles) expect(title.x).toBe(slots[0].right + 16)
    const art = rows.map(row => row.querySelector<HTMLElement>('canvas, svg[viewBox="0 0 36 36"], svg.gg-project-avatar')!.getBoundingClientRect())
    art.forEach((rect, i) => {
      expect(rect.width).toBe(48); expect(rect.height).toBe(48)
      expect(rect.x + rect.width / 2).toBe(slots[i].x + slots[i].width / 2)
      expect(rect.y + rect.height / 2).toBe(slots[i].y + slots[i].height / 2)
    })
    const pending = rows[1].querySelector<HTMLElement>('.gg-phone-message-avatar-badge')!.getBoundingClientRect()
    const folder = rows[2].querySelector<HTMLElement>('.gg-phone-message-avatar-badge')!.getBoundingClientRect()
    const ordinary = rows[3].querySelector<HTMLElement>('.av-status')!.getBoundingClientRect()
    for (const [badge, index] of [[pending, 1], [folder, 2], [ordinary, 3]] as const) {
      expect(badge.x + badge.width / 2 - slots[index].right).toBe(-5)
      expect(badge.y + badge.height / 2 - slots[index].top).toBe(5)
    }
    expect(rows[1].querySelector('.gg-list-row-trailing')).toBeNull()
  },
)

it('keeps desktop leading geometry at its existing content size', async () => {
  await harness.render(<ListRow title="Desktop" leading={<Avatar name="Desktop" seed="desktop" size="sm" isAgent />} />)
  const slot = harness.container.querySelector<HTMLElement>('.gg-list-row-leading')!.getBoundingClientRect()
  expect(slot.width).toBe(32); expect(slot.height).toBe(32)
})

it('reserves the same slot when artwork has a different intrinsic aspect ratio', async () => {
  await harness.render(<div data-phone-shell=""><div data-phone-root-list="chats">
    <ListRow mobile title="Wide artwork" leading={<svg width={120} height={24} viewBox="0 0 120 24" aria-hidden><rect width={120} height={24} /></svg>} />
    <ListRow mobile title="Small artwork" leading={<svg width={20} height={20} viewBox="0 0 20 20" aria-hidden><circle cx={10} cy={10} r={10} /></svg>} />
  </div></div>)
  const rows = [...harness.container.querySelectorAll<HTMLElement>('.gg-list-row')]
  for (const row of rows) {
    const slot = row.querySelector<HTMLElement>('.gg-list-row-leading')!.getBoundingClientRect()
    const art = row.querySelector('svg')!.getBoundingClientRect()
    expect(slot.width).toBe(48); expect(slot.height).toBe(48)
    expect(art.width).toBeGreaterThan(0); expect(art.width).toBeLessThanOrEqual(48)
    expect(art.x + art.width / 2).toBe(slot.x + slot.width / 2)
    expect(art.y + art.height / 2).toBe(slot.y + slot.height / 2)
    expect(row.querySelector('.gg-list-row-title')!.getBoundingClientRect().x).toBe(slot.right + 16)
  }
})
