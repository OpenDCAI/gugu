// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

const drawn: string[] = []
let release: (() => void) | null = null
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, chart: string) => {
      // the first diagram holds the queue until the test lets it go
      if (drawn.length === 0) await new Promise<void>((resolve) => (release = resolve))
      drawn.push(chart)
      return { svg: `<svg>${chart}</svg>` }
    })
  }
}))

const { createMermaidRenderId, renderMermaidDiagram } = await import('./render')
const request = (chart: string, signal?: AbortSignal) =>
  renderMermaidDiagram({ id: createMermaidRenderId(), chart, theme: 'neutral', signal })

describe('renderMermaidDiagram queue', () => {
  it('skips requests aborted while they waited, and renders the rest in order', async () => {
    const first = request('first')
    const stale = [new AbortController(), new AbortController(), new AbortController()]
    const staleResults = stale.map((c, i) => request(`stale-${i}`, c.signal).then(() => 'drawn', (e: Error) => e.name))
    const latest = request('latest', new AbortController().signal)

    // the earlier versions of a streaming block are abandoned while the first diagram still renders
    for (const c of stale) c.abort()
    await vi.waitUntil(() => release !== null)
    release!()

    expect(await first).toBe('<svg>first</svg>')
    expect(await latest).toBe('<svg>latest</svg>')
    expect(await Promise.all(staleResults)).toEqual(['AbortError', 'AbortError', 'AbortError'])
    expect(drawn).toEqual(['first', 'latest'])
  })
})
