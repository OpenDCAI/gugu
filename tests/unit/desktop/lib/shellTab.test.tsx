// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { createShellTabStore, ShellTabContext, useShellTabIs } from '../../../../apps/desktop/src/lib/shellTab'
import type { SidebarTab } from '../../../../packages/core/src/shared/enums/sidebarTabModels'

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

it('a tab switch re-renders only the surfaces whose "am I shown" answer changed', async () => {
  const renders: Record<string, number> = {}
  function Surface({ tab }: { tab: SidebarTab }) {
    const shown = useShellTabIs(tab)
    renders[tab] = (renders[tab] ?? 0) + 1
    return createElement('div', { 'data-surface': tab, 'data-shown': String(shown) })
  }
  const store = createShellTabStore('tasks')
  harness = createReactHarness()
  await harness.render(createElement(ShellTabContext.Provider, { value: store },
    (['tasks', 'contacts', 'settings'] as const).map((tab) => createElement(Surface, { key: tab, tab }))))
  expect(renders).toEqual({ tasks: 1, contacts: 1, settings: 1 })
  await act(async () => store.set('contacts'))
  expect(renders, 'settings stayed hidden: not rendered again').toEqual({ tasks: 2, contacts: 2, settings: 1 })
  expect(harness.container.querySelector('[data-surface="contacts"]')!.getAttribute('data-shown')).toBe('true')
  await act(async () => store.set('contacts'))
  expect(renders, 'setting the same tab is not a switch').toEqual({ tasks: 2, contacts: 2, settings: 1 })
})
