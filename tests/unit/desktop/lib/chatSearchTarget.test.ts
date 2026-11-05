// @vitest-environment jsdom
// #7199
import { afterEach, describe, expect, it, vi } from 'vitest'
const shown = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../../../apps/desktop/src/lib/onScreenChat', () => ({ chatOnScreen: () => shown.id }))
import { isChatSearchTarget } from '../../../../apps/desktop/src/lib/chatSearchTarget'

afterEach(() => { document.body.replaceChildren(); shown.id = null })
describe('search across two visible chats', () => {
  it('keeps Alt+F usable with focus outside the chat', () => {
    expect(isChatSearchTarget(null, 'assistant')).toBe(true)
    shown.id = 'task'
    expect(isChatSearchTarget(null, 'task')).toBe(true)
    expect(isChatSearchTarget(null, 'assistant')).toBe(false)
  })
  it('searches only the focused conversation when two chats are visible', () => {
    const left = document.createElement('div'), right = document.createElement('div')
    left.dataset.chatSurface = 'assistant'; right.dataset.chatSurface = 'task'
    const input = document.createElement('input')
    left.append(input); document.body.append(left, right)
    shown.id = 'task'; input.focus()
    expect(isChatSearchTarget(left, 'assistant')).toBe(true)
    expect(isChatSearchTarget(right, 'task')).toBe(false)
  })
  it('uses the clicked chat when a non-focusable timeline leaves focus on the body', () => {
    const left = document.createElement('div'), right = document.createElement('div')
    left.dataset.chatSurface = 'left'; right.dataset.chatSurface = 'right'
    const message = document.createElement('p'); right.append(message)
    document.body.append(left, right); shown.id = 'left'
    expect(isChatSearchTarget(left, 'left', message)).toBe(false)
    expect(isChatSearchTarget(right, 'right', message)).toBe(true)
  })
  it('a result row of a panel that has since closed is no focus: the chat on screen is the target again', () => {
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog')
    const row = document.createElement('button'); dialog.append(row); document.body.append(dialog)
    shown.id = 'task'
    expect(isChatSearchTarget(null, 'task', row)).toBe(false)
    dialog.remove()
    expect(isChatSearchTarget(null, 'task', row)).toBe(true)
  })
  it('does not search the chat behind an open settings dialog', () => {
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog')
    const input = document.createElement('input'); dialog.append(input); document.body.append(dialog)
    shown.id = 'task'; input.focus()
    expect(isChatSearchTarget(null, 'task')).toBe(false)
  })
})
