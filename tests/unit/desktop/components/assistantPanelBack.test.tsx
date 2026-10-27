// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness, clickElement } from '../../../support/testHarness'
import { useAssistantPanelBack, useAssistantPanelPage } from '../../../../apps/desktop/src/lib/assistantPanelPage'

const harnesses: ReturnType<typeof createReactHarness>[] = []
afterEach(() => { for (const harness of harnesses.splice(0)) harness.cleanup() })

it('lets the outer toolbar return from a page rendered in another root', async () => {
  const toolbar = createReactHarness(), content = createReactHarness()
  harnesses.push(toolbar, content)
  const closed = vi.fn()
  function Toolbar() { const page = useAssistantPanelPage(); return page ? <button onClick={page.back}>返回</button> : null }
  function Content() {
    const [open, setOpen] = useState(true)
    useAssistantPanelBack(open ? 'connector:feishu' : null, () => { closed(); setOpen(false) })
    return <span>{open ? '飞书' : '应用列表'}</span>
  }
  await toolbar.render(<Toolbar />)
  await content.render(<Content />)
  await clickElement(toolbar.container.querySelector('button')!)
  expect(closed).toHaveBeenCalledTimes(1)
  expect(content.container.textContent).toBe('应用列表')
  expect(toolbar.container.querySelector('button')).toBeNull()
})

it('keeps standalone settings out of the panel toolbar', async () => {
  const harness = createReactHarness(); harnesses.push(harness)
  function Settings() { useAssistantPanelBack(null, () => {}); return <span>{useAssistantPanelPage()?.key ?? 'standalone'}</span> }
  await harness.render(<Settings />)
  expect(harness.container.textContent).toBe('standalone')
})
