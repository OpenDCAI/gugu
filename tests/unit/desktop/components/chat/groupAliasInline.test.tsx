// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../../../support/testHarness'
import { GroupNameRow } from '@/components/chat/GroupNameRow'
import { GroupNameInlineEdit } from '@/components/chat/GroupNameInlineEdit'
import { updateDisplayAlias } from '@/lib/displayOverrides'

vi.mock('@/lib/displayOverrides', () => ({ updateDisplayAlias: vi.fn(async () => {}) }))
let ui: ReturnType<typeof createReactHarness>
const input = () => ui.container.querySelector<HTMLInputElement>('input')!
const key = async (key: string) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
beforeEach(() => { ui = createReactHarness(); vi.clearAllMocks() })
afterEach(() => ui.cleanup())
async function render(alias: string | null = null) {
  const patchChat = vi.fn()
  const rename = vi.fn()
  await renderWithAppProviders(ui, createNode(GroupNameRow, {
    chat: chat({ id: 'group-1', kind: 'group', name: 'Shared name', alias }),
    name: 'Shared name', canEdit: false, onCommit: rename,
  }), { chat: { patchChat } })
  await clickElement(ui.container.querySelector('[data-testid="group-set-alias"]')!)
  return { patchChat, rename }
}
describe('group alias edits in its original name position', () => {
  it('Enter persists a personal alias without changing the shared group name or opening a sheet', async () => {
    const { patchChat, rename } = await render()
    expect(ui.container.querySelector('[data-testid="group-name-display"]')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await typeInto(input(), '  My group  ')
    await key('Enter')
    expect(updateDisplayAlias).toHaveBeenCalledExactlyOnceWith('user-1', { kind: 'group', id: 'group-1' }, 'My group')
    expect(patchChat).toHaveBeenCalledExactlyOnceWith('group-1', { alias: 'My group' })
    expect(rename).not.toHaveBeenCalled()
    expect(input()).toBeNull()
  })
  it('Escape restores the name without writing the changed draft', async () => {
    const { patchChat } = await render('Old alias')
    expect(input().value).toBe('Old alias')
    await typeInto(input(), 'Discard me')
    await key('Escape')
    expect(ui.container.querySelector('[data-testid="group-name-display"]')?.textContent).toBe('Shared name')
    expect(updateDisplayAlias).not.toHaveBeenCalled()
    expect(patchChat).not.toHaveBeenCalled()
  })
  it('allows an empty alias to remove the override, while the same name input rejects an empty shared name', async () => {
    const { patchChat } = await render('Old alias')
    await typeInto(input(), '')
    await key('Enter')
    expect(patchChat).toHaveBeenCalledWith('group-1', { alias: null })
    const rename = vi.fn()
    await ui.render(createNode(GroupNameInlineEdit, { name: 'Shared name', canEdit: true, onCommit: rename }))
    await clickElement(ui.container.querySelector('[data-testid="group-name-edit"]')!)
    await typeInto(input(), '')
    await key('Enter')
    expect(rename).not.toHaveBeenCalled()
    expect(input()).toBeNull()
  })
})
