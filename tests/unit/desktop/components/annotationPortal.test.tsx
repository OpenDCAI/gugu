// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { Sheet } from '../../../../apps/desktop/src/components/ui/Sheet'
import { Menu, MenuItem } from '../../../../apps/desktop/src/components/ui/Menu'
import { Field } from '../../../../apps/desktop/src/components/ui/Field'

let harness: ReturnType<typeof createReactHarness>, viewer: HTMLDivElement
beforeEach(() => { harness = createReactHarness(); viewer = document.createElement('div'); document.body.append(viewer) })
afterEach(() => { harness.cleanup(); viewer.remove() })
describe('popups inside the shared image viewer', () => {
  it('places the real shared Sheet and its editable field inside the declared viewer host', async () => {
    await harness.render(createNode(UiPortalContainerProvider, { value: viewer }, createNode(Sheet, { onClose: vi.fn(), ariaLabel: 'Numbered note' },
      createNode(Field.Root, {}, createNode(Field.Label, {}, 'Note'), createNode(Field.Input, { autoFocus: true })))) )
    const dialog = viewer.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(viewer.contains(dialog!.querySelector('input'))).toBe(true)
    expect(viewer.contains(document.activeElement)).toBe(true)
  })
  it('places the existing Menu in that same host so PhotoSwipe does not steal menu focus', async () => {
    const anchor = document.createElement('button'); viewer.append(anchor)
    await harness.render(createNode(UiPortalContainerProvider, { value: viewer }, createNode(Menu, { anchor, onClose: vi.fn() },
      createNode(MenuItem, { onClick: vi.fn() }, 'Copy image'))))
    expect(viewer.querySelector('[role="menuitem"]')?.textContent).toBe('Copy image')
  })
  it('keeps normal sheets on the existing body portal when no host was declared', async () => {
    await harness.render(createNode(Sheet, { onClose: vi.fn(), ariaLabel: 'Ordinary sheet' }, 'Content'))
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(viewer.querySelector('[role="dialog"]')).toBeNull()
  })
})
