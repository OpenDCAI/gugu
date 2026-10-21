// @vitest-environment jsdom
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
})
