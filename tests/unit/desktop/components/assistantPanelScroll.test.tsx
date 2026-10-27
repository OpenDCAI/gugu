// @vitest-environment jsdom
import { useRef } from 'react'
import { expect, it } from 'vitest'
import { usePanelScroll } from '../../../../apps/desktop/src/session/renderer/features/assistant/use-panel-scroll'
import { createReactHarness } from '../../../support/testHarness'

it('remembers the index when a portal attaches its scroll body after the initial render', async () => {
  const h = createReactHarness()
  function Page({ name, shown }: { name: string; shown: boolean }) {
    const body = useRef<HTMLDivElement>(null)
    const attach = usePanelScroll(body, name)
    return shown ? <div ref={attach}>{name}</div> : null
  }
  try {
    await h.render(<Page name="index" shown={false} />)
    await h.render(<Page name="index" shown />)
    const body = h.container.firstElementChild!
    body.scrollTop = 380
    body.dispatchEvent(new Event('scroll'))
    await h.render(<Page name="detail" shown />)
    expect(body.scrollTop).toBe(0)
    await h.render(<Page name="index" shown />)
    expect(body.scrollTop).toBe(380)
  } finally { h.cleanup() }
})
