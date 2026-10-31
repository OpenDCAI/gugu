// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { clickElement, contact, contactsStore, createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  Element.prototype.scrollIntoView = vi.fn() // jsdom 没有 scrollIntoView
})
afterEach(() => { harness.cleanup() })

const people = [
  contact({ id: 'zs', display_name: '张三', gugu_number: 109591 }),
  contact({ id: 'ls', display_name: '李四', alias: '老李', gugu_number: 109592 }),
  contact({ id: 'alan', display_name: 'Alan' }),
  contact({ id: 'alba', display_name: 'Alba' }),
  contact({ id: 'albot', display_name: 'Albot', type: 'agent', owner_user_id: 'owner-1', device_id: null }),
]
const groups = [
  { id: 'g1', kind: 'group' as const, name: 'Alpha Team', public_id: 208864, avatar_url: null, member_count: 2, is_muted: false, member_user_ids: ['owner-1', 'zs'] },
]

async function render(options: { mobile?: boolean; contacts?: Parameters<typeof contactsStore>[0] } = {}) {
  const onOpenGroupChat = vi.fn()
  await renderWithAppProviders(harness, createNode(ContactsPanel, { mobile: options.mobile ?? false, onOpenGroupChat }), { shellTab: 'contacts',
    auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
    contacts: { contacts: people, groupChats: groups, ...options.contacts },
    chat: { chats: [] },
  })
  return { onOpenGroupChat }
}
const $ = (selector: string) => harness.container.querySelector(selector) as HTMLElement | null
const input = () => $(`[data-testid="${AUTOMATION_TEST_IDS.contactsSearchInput}"]`) as HTMLInputElement
const results = () => $('[data-testid="contacts-search-results"]')
const rows = () => Array.from(results()?.querySelectorAll<HTMLElement>('[data-search-row]') ?? [])
const titles = () => rows().map((row) => row.querySelector('.gg-list-row-title')?.textContent)
const sections = () => Array.from(results()?.querySelectorAll('[data-slot="section-label"]') ?? []).map((label) => label.textContent)
const subtitle = (index: number) => rows()[index]?.querySelector('.gg-list-row-subtitle')?.textContent
const detailTitle = () => $('[data-slot="pane"][data-role="detail"] [data-slot="pane-header"]')?.textContent ?? ''
const browseHidden = () => $('[data-testid="contacts-browse"]')?.className === 'hidden'
const press = (key: string) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })

describe('contacts search (desktop sidebar)', () => {
  it('swaps the browse tree for one grouped results table and brings it back on clear', async () => {
    await render()
    expect(results()).toBeNull()
    expect(browseHidden()).toBe(false)

    await typeInto(input(), 'zs')
    expect(sections()).toEqual(['个人'])
    expect(titles()).toEqual(['张三'])
    // 搜索时「新的请求」、设备段、个人 / 群组折叠树整块让位(隐藏不卸载)
    expect(browseHidden()).toBe(true)

    await typeInto(input(), 'xyz')
    expect(rows()).toHaveLength(0)
    expect(results()?.textContent).toBe('无匹配结果')

    await clickElement($('[aria-label="清除搜索"]')!)
    expect(input().value).toBe('')
    expect(results()).toBeNull()
    expect(browseHidden()).toBe(false)
  })

  it('marks the hit characters by ink fill: hits full, the rest muted', async () => {
    await render({ contacts: { contacts: [...people, contact({ id: 'yj', display_name: '𠮷野家' })] } })
    const segments = () => Array.from(rows()[0].querySelectorAll('.gg-list-row-title span')).map((span) => [span.textContent, span.className])
    await typeInto(input(), 'lan')
    expect(segments()).toEqual([['A', 'text-[var(--muted-fg)]'], ['lan', 'text-[var(--fg)]']])
    await typeInto(input(), 'alan')
    expect(segments()).toEqual([['Alan', 'text-[var(--fg)]']])
    // 代理对不被切开
    await typeInto(input(), '𠮷')
    expect(segments()).toEqual([['𠮷', 'text-[var(--fg)]'], ['野家', 'text-[var(--muted-fg)]']])
  })

  it('says why a row matched when the hit is not in the shown name', async () => {
    await render()
    await typeInto(input(), '李四')
    expect(titles()).toEqual(['老李'])
    expect(subtitle(0)).toBe('原名 李四')
    await typeInto(input(), '109592')
    expect(subtitle(0)).toBe('咕咕号 109592')
    await typeInto(input(), '208864')
    expect(sections()).toEqual(['群组'])
    expect(subtitle(0)).toBe('群号 208864')
  })

  it('moves with arrows and opens on Enter; typing alone does not change the detail pane', async () => {
    await render()
    const before = detailTitle()
    await typeInto(input(), 'al')
    expect(sections()).toEqual(['个人', 'Agent', '群组'])
    expect(titles()).toEqual(['Alan', 'Alba', 'Albot', 'Alpha Team'])
    expect(rows()[0].hasAttribute('data-selected')).toBe(true)
    expect(detailTitle()).toBe(before)

    await press('ArrowDown')
    await press('ArrowDown')
    expect(rows()[2].hasAttribute('data-selected')).toBe(true)
    await press('Enter')
    expect(detailTitle()).toBe('Albot')
    await press('ArrowUp')
    await press('Enter')
    expect(detailTitle()).toBe('Alba')
  })

  it('offers a 咕咕号 lookup when a number finds nobody, and seeds the add-contact search with it', async () => {
    const searchUsers = vi.fn(async () => {})
    await render({ contacts: { searchUsers } })
    await typeInto(input(), '109601')
    expect(titles()).toEqual(['用咕咕号 109601 查找'])
    await press('Enter')
    expect(searchUsers).toHaveBeenCalledWith('109601')
    await typeInto(input(), 'nobody')
    expect(rows()).toHaveLength(0)
  })

  it('ticks a person instead of opening them while picking people for a new group', async () => {
    await render()
    await clickElement($(`[data-testid="${AUTOMATION_TEST_IDS.contactsSelectModeButton}"]`)!)
    await typeInto(input(), '张')
    await clickElement(rows()[0])
    expect(rows()[0].getAttribute('aria-pressed')).toBe('true')
    expect(harness.container.textContent).toContain('已选 1 人')
  })
})

describe('contacts search (phone home)', () => {
  it('shows results in place of the menu, keeps them across a detail visit, and leaves sub-pages unfiltered', async () => {
    const { onOpenGroupChat } = await render({ mobile: true })
    const menuRow = (label: string) => Array.from(harness.container.querySelectorAll<HTMLElement>('button.gg-row')).find((button) => button.textContent?.startsWith(label))

    // 手机上框收在页头:先点放大镜(ui/HeaderSearch)。
    expect(input()).toBeNull()
    await clickElement($('[data-header-search-open]')!)
    await typeInto(input(), '张')
    expect(browseHidden()).toBe(true)
    expect(titles()).toEqual(['张三'])

    await clickElement(rows()[0])
    expect(detailTitle()).toBe('张三')
    await clickElement($('[aria-label="返回联系人列表"]')!)
    expect(input().value).toBe('张')
    expect(titles()).toEqual(['张三'])

    await typeInto(input(), 'alpha')
    await clickElement(rows()[0])
    expect(onOpenGroupChat).toHaveBeenCalledWith(groups[0])

    await typeInto(input(), '')
    await clickElement(menuRow('个人')!)
    expect(Array.from(harness.container.querySelectorAll('[data-contact-id]')).map((row) => row.getAttribute('data-contact-id')).sort())
      .toEqual(['alan', 'alba', 'ls', 'zs'])
  })

  // 软键盘上的「搜索 / 前往」就是回车:页头里的框接的是桌面那颗框同一份键盘处理。
  it('opens the first hit on Enter from the header box', async () => {
    await render({ mobile: true })
    await clickElement($('[data-header-search-open]')!)
    await typeInto(input(), '张')
    expect(detailTitle()).not.toBe('张三')
    await press('Enter')
    expect(detailTitle()).toBe('张三')
  })

  it('looks a 咕咕号 up on Enter from the header box when it finds nobody', async () => {
    const searchUsers = vi.fn(async () => {})
    await render({ mobile: true, contacts: { searchUsers } })
    await clickElement($('[data-header-search-open]')!)
    await typeInto(input(), '109601')
    expect(titles()).toEqual(['用咕咕号 109601 查找'])
    expect(searchUsers).not.toHaveBeenCalled()
    await press('Enter')
    expect(searchUsers).toHaveBeenCalledWith('109601')
  })
})
