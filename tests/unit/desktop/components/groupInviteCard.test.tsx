// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => createElement('span', { 'data-avatar': true }) }))
import { GroupInviteCard, type GroupInviteCardGroup } from '../../../../apps/desktop/src/components/groups/GroupInviteCard'
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
function baseGroup(): GroupInviteCardGroup {
  return {
    id: 'group-1',
    public_id: 778899,
    name: '共享群',
    member_count: 12,
    is_member: false,
    join_mode: 'open' as const,
    join_request_status: null,
  }
}
describe('GroupInviteCard (#3303)', () => {
  it.each([
    ['joinable', {}, false],
    ['joined', { is_member: true }, true],
    ['pending', { join_request_status: 'pending' }, true],
    ['invite_only', { join_mode: 'invite_only' }, true],
    ['invite_link_closed', { inviteLinkEnabled: false }, true],
    ['failed', { joinError: '群已满员' }, false],
  ])('呈现 %s 状态，只有可动作状态保留按钮', async (state, overrides, disabled) => {
    const cardOverrides = overrides as Partial<GroupInviteCardGroup> & { inviteLinkEnabled?: boolean; joinError?: string }
    await act(async () => {
      root.render(createElement(GroupInviteCard, {
        group: { ...baseGroup(), ...cardOverrides },
        inviteLinkEnabled: cardOverrides.inviteLinkEnabled ?? true,
        joinError: cardOverrides.joinError ?? null,
        onJoin: vi.fn(),
        density: 'list',
      }))
    })
    const card = container.querySelector('[data-testid="group-invite-card"]')
    expect(card?.getAttribute('data-state')).toBe(state)
    const button = container.querySelector('button') as HTMLButtonElement | null
    if (disabled) expect(button?.disabled ?? true).toBe(true)
    else expect(button?.disabled).toBe(false)
  })
  it('同一组件用 density 切换内联卡与列表行，不复制内容结构', async () => {
    await act(async () => root.render(createElement(GroupInviteCard, { group: baseGroup(), density: 'inline' })))
    const card = container.querySelector('[data-testid="group-invite-card"]')
    expect(card?.getAttribute('data-density')).toBe('inline')
    expect(card?.textContent).toContain('共享群')
    expect(card?.textContent).toContain('778899')
    expect(card?.textContent).toContain('12')
  })
})
