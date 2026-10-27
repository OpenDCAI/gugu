// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectRowContextMenu } from '../../../../apps/desktop/src/components/chat/ProjectRowContextMenu'
import { publishChatSummaries } from '../../../../apps/desktop/src/lib/chatSummariesBridge'
import { takeShellChatAction } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { clickElement, createReactHarness } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  takeShellChatAction((value): value is typeof value => true)
  publishChatSummaries([
    { id: 'project-group', kind: 'group', unread_count: 0 },
    { id: 'child-topic', kind: 'topic', source_chat_id: 'project-group', unread_count: 3 },
    { id: 'outside', kind: 'group', unread_count: 8 },
  ])
})
afterEach(() => harness.cleanup())

async function render(disabled = false, chatId: string | undefined = 'project-group') {
  await harness.render(createElement(ProjectRowContextMenu, { disabled, chatId, projectId: 'project', onRemove: vi.fn(),
    children: createElement('span', { 'data-testid': 'project-row' }, 'Project') }))
  await act(async () => {
    harness.container.querySelector('[data-testid=project-row]')!.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 120, clientY: 240,
    }))
  })
}

describe('project row menu across the two React roots', () => {
  it('uses child-topic unread and dispatches the selected group through the existing shell action channel', async () => {
    // Deliberately no ChatStoreProvider: the project lives in the other React root.
    await render()
    const read = document.querySelector<HTMLElement>('[data-testid=conversation-row-mark-read]')!
    expect(read.getAttribute('aria-disabled')).not.toBe('true')
    expect([...document.querySelectorAll('[role=menuitem]')].map((item) => item.getAttribute('data-testid')))
      .toEqual(['conversation-row-mark-read', 'conversation-row-remove-project'])
    await clickElement(read)
    expect(takeShellChatAction((value): value is typeof value => true)).toEqual({ kind: 'mark-read', chatId: 'project-group' })
    expect(document.querySelector('[role=menu]')).toBeNull()
  })

  it('disables scoped read when only unrelated conversations have unread messages', async () => {
    publishChatSummaries([
      { id: 'project-group', kind: 'group', unread_count: 0 },
      { id: 'outside', kind: 'group', unread_count: 8 },
    ])
    await render()
    expect(document.querySelector('[data-testid=conversation-row-mark-read]')?.getAttribute('aria-disabled')).toBe('true')
    expect(document.querySelector('[data-testid=conversation-row-remove-project]')?.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('keeps the whole menu unavailable under the stand-in/assistant-home restriction', async () => {
    await render(true)
    expect(document.querySelector('[role=menu]')).toBeNull()
    expect(takeShellChatAction((value): value is typeof value => true)).toBeNull()
  })
})
