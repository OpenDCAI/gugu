// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), join: vi.fn(), refresh: vi.fn(), user: { id: 'test-reader' } as { id: string } | null }))
vi.mock('../../../../apps/desktop/src/components/supportHelp/api', () => ({ fetchSupportHelp: mocks.fetch, joinSupportHelp: mocks.join }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: mocks.user }) }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ refreshChats: mocks.refresh }) }))
import { SupportHelp } from '../../../../apps/desktop/src/components/supportHelp/SupportHelp'
import { Menu } from '../../../../apps/desktop/src/components/ui/Menu'
import { queryClient } from '../../../../apps/desktop/src/session/renderer/lib/query-client'
import { i18n } from '../../../../apps/desktop/src/i18n'
import type { SupportHelpInfo } from '../../../../apps/desktop/src/components/supportHelp/contract'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement; let root: Root
const closeMenu = vi.fn(); const openGroup = vi.fn()
const preview = (name = '帮助群 A', version = 1): SupportHelpInfo => ({
  support_help_entry_enabled: true, version,
  group: { id: `test-${version}`, public_id: 9001926 + version, name, join_mode: 'approval',
    is_member: false, join_request_status: null, availability: 'available' },
  duty_human: { id: 'test-duty', display_name: '值班真人' }, assistants: [],
})
const menu = (entry: ReactNode) => createElement(Menu, { x: 10, y: 10, children: entry, ariaLabel: 'Test help menu' })
async function render(generation = 1) {
  await act(async () => root.render(createElement(SupportHelp, {
    helpOpen: true, generation, onCloseMenu: closeMenu, onOpenGroup: openGroup, children: menu,
  })))
  await settle()
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) }) }
function entry() { return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((node) => node.textContent?.includes('进入帮助群')) }
function action(label: string) { return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((node) => node.textContent === label)! }
async function open() { await act(async () => entry()!.click()); await settle() }
beforeEach(async () => {
  vi.clearAllMocks(); mocks.user = { id: 'test-reader' }; queryClient.clear()
  mocks.fetch.mockResolvedValue(preview()); mocks.refresh.mockResolvedValue(undefined)
  await i18n.changeLanguage('zh-CN')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); queryClient.clear(); container.remove() })

describe('support help release lifecycle', () => {
  it('renders no support entry, separator or placeholder while the gate is closed', async () => {
    mocks.fetch.mockResolvedValue({ support_help_entry_enabled: false })
    await render()
    expect(entry()).toBeUndefined()
    expect(document.querySelector('[role="separator"]')).toBeNull()
    expect(document.body.textContent).not.toContain('帮助群')
  })
  it('does not join when showing the group name and public visibility', async () => {
    await render(); await open()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('帮助群 A')
    expect(document.body.textContent).toContain('群内发言对成员可见。')
    expect(mocks.join).not.toHaveBeenCalled()
  })
  it('blocks concurrent clicks and leaves an approval result pending', async () => {
    let finish!: (result: unknown) => void
    mocks.join.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await render(); await open()
    await act(async () => { action('申请加入').click(); action('申请加入').click() })
    expect(mocks.join).toHaveBeenCalledTimes(1)
    const pending = preview(); pending.group.join_request_status = 'pending'
    await act(async () => finish({ status: 'pending', info: pending })); await settle()
    expect(document.body.textContent).toContain('等待管理员审核')
    expect(action('申请加入').disabled).toBe(true)
    expect(openGroup).not.toHaveBeenCalled()
  })
  it('requires another explicit click after a configured group switch', async () => {
    const next = preview('帮助群 B', 2)
    mocks.join.mockResolvedValueOnce({ status: 'config_changed', info: next })
    await render(); await open()
    await act(async () => action('申请加入').click()); await settle()
    expect(document.body.textContent).toContain('帮助群 B')
    expect(document.body.textContent).toContain('请核对后再次点击')
    expect(mocks.join).toHaveBeenCalledTimes(1)
    mocks.join.mockResolvedValueOnce({ status: 'pending', info: { ...next, group: { ...next.group, join_request_status: 'pending' } } })
    await act(async () => action('申请加入').click()); await settle()
    expect(mocks.join.mock.calls[1]![0]).toMatchObject({ version: 2, group: { id: 'test-2' } })
  })
  it('closes the dialog and removes the entry when the server revokes the gate', async () => {
    await render(); await open()
    mocks.fetch.mockResolvedValue({ support_help_entry_enabled: false })
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['support-help'] }) }); await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(entry()).toBeUndefined()
  })
  it('does not flash a cached enabled entry when help is reopened', async () => {
    await render(); expect(entry()).toBeDefined()
    let finish!: (result: unknown) => void
    mocks.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await render(2)
    expect(entry()).toBeUndefined()
    await act(async () => finish({ support_help_entry_enabled: false })); await settle()
    expect(entry()).toBeUndefined()
  })
  it('requires sign-in for an anonymous preview', async () => {
    mocks.user = null
    const anonymous = preview(); anonymous.group.id = null; anonymous.duty_human = null
    mocks.fetch.mockResolvedValue(anonymous)
    await render(); await open()
    expect(action('申请加入').disabled).toBe(true)
    expect(document.body.textContent).toContain('登录后才能加入帮助群')
    expect(mocks.join).not.toHaveBeenCalled()
  })
})
