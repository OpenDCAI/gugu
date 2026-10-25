// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OwnedAgentNameEditor } from '../../../../apps/desktop/src/components/contacts/OwnedAgentNameEditor'

const { renameAgent, viewer } = vi.hoisted(() => ({ renameAgent: vi.fn(), viewer: { id: 'owner' } }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: viewer }) }))
vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ renameAgent }) }))
let container: HTMLDivElement
let root: Root
function render(overrides: Partial<Parameters<typeof OwnedAgentNameEditor>[0]> = {}) {
  act(() => root.render(createElement(OwnedAgentNameEditor, { agentId: 'stable-id', ownerUserId: 'owner', name: 'Codex 8', children: 'Codex 8', ...overrides })))
}
function click(text: string) {
  // Rename / save / cancel are icon buttons: their name is the aria-label.
  const button = [...container.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === text || node.textContent?.includes(text))
  if (!button) throw new Error(`Missing button: ${text}`)
  act(() => button.click())
}
function input() {
  const node = container.querySelector('input')
  if (!node) throw new Error('Missing name input')
  return node
}
function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function save() { await act(async () => click('保存')) }
beforeEach(() => {
  renameAgent.mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
describe('owner agent name editor #6021', () => {
  it.each([{ ownerUserId: 'other' }, { ownerUserId: null }, { status: 'removed' as const }, { membership: 'removed' }])('never offers rename for non-owned or removed identities: %j', (props) => {
    render(props)
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toBe('Codex 8')
  })
  it('saves a trimmed name on the same identity and reopens from the published name', async () => {
    render()
    click('重命名')
    expect(input().value).toBe('Codex 8')
    type('  小助手  ')
    await save()
    expect(renameAgent).toHaveBeenCalledExactlyOnceWith('stable-id', '小助手')
    expect(container.querySelector('input')).toBeNull()
    render({ name: '小助手' })
    click('重命名')
    expect(input().value).toBe('小助手')
  })
  it('rejects whitespace names and preserves the draft', async () => {
    render(); click('重命名'); type('  '); await save()
    expect(renameAgent).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('名称不能为空')
    expect(input().value).toBe('  ')
  })
  it('cancel and Escape discard edits without saving or escaping the enclosing popover', () => {
    render(); click('重命名'); type('取消的名字'); click('取消')
    click('重命名')
    expect(input().value).toBe('Codex 8')
    const outer = vi.fn()
    container.addEventListener('keydown', outer)
    act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(renameAgent).not.toHaveBeenCalled()
    expect(container.querySelector('input')).toBeNull()
    container.removeEventListener('keydown', outer)
  })
  it('keeps a failed draft and retries even when the cloud name was already published', async () => {
    renameAgent.mockRejectedValueOnce(new Error('local roster unavailable'))
    render(); click('重命名'); type('新名字'); await save()
    expect(input().value).toBe('新名字')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('local roster unavailable')
    render({ name: '新名字' })
    await save()
    expect(renameAgent).toHaveBeenCalledTimes(2)
    expect(container.querySelector('input')).toBeNull()
  })
  it('prevents duplicate saves while persistence is pending', async () => {
    let finish!: () => void
    renameAgent.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    render(); click('重命名'); type('新名字'); await save()
    expect(input().disabled).toBe(true)
    expect([...container.querySelectorAll('button')].every((button) => button.disabled)).toBe(true)
    expect(renameAgent).toHaveBeenCalledTimes(1)
    await act(async () => finish())
  })
})
