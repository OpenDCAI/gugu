// @vitest-environment jsdom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MobileWorkspace, MobileWorkspaceTabs, type MobileWorkspaceSection } from '../../../apps/desktop/src/mobile/workspace/MobileWorkspace'
import { clickElement, createReactHarness } from '../../support/testHarness'

function Workspace() {
  const [section, setSection] = useState<MobileWorkspaceSection>('projects')
  const [draft, setDraft] = useState('')
  return <MobileWorkspace section={section}
    projects={<><MobileWorkspaceTabs value="projects" onChange={setSection} /><input aria-label="task draft" value={draft} onChange={(event) => setDraft(event.target.value)} /></>}
    groups={<><MobileWorkspaceTabs value="groups" onChange={setSection} /><input aria-label="group draft" defaultValue="群里的草稿" /></>}
  />
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())
const surface = (section: MobileWorkspaceSection) => harness.container.querySelector(`[data-workspace-section="${section}"]`)!
const tab = (section: MobileWorkspaceSection, target: MobileWorkspaceSection) => surface(section).querySelector<HTMLButtonElement>(`[data-testid="mobile-workspace-${target}"]`)!

describe('retained workspace navigation', () => {
  it('continues keyboard switching on the visible header, instead of the hidden duplicate', async () => {
    await harness.render(<Workspace />)
    await act(async () => {
      tab('projects', 'projects').focus()
      tab('projects', 'projects').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(document.activeElement).toBe(tab('groups', 'groups'))
    expect(surface('projects').hasAttribute('inert')).toBe(true)
    await act(async () => {
      tab('groups', 'groups').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(document.activeElement).toBe(tab('projects', 'projects'))
  })

  it('keeps each existing surface and its draft mounted across switches', async () => {
    await harness.render(<Workspace />)
    const task = surface('projects').querySelector('input')!
    const group = surface('groups').querySelector('input')!
    await clickElement(tab('projects', 'groups'))
    await clickElement(tab('groups', 'projects'))
    expect(surface('projects').querySelector('input')).toBe(task)
    expect(surface('groups').querySelector('input')).toBe(group)
    expect(group.value).toBe('群里的草稿')
  })
})
