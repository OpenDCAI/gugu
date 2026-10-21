// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Markdown } from '../../../../apps/desktop/src/components/markdown/Markdown'
import { buildMentionRender } from '../../../../apps/desktop/src/lib/mentionRenderModel'
import {
  COMMITTED_RESEARCH_FULL,
  COMMITTED_RESEARCH_MATH_COUNT,
  COMMITTED_RESEARCH_PREFIX,
} from './committedResearchMarkdownFixture'
const MARKER = '#ggm-committed-research'
const RAW_DELIMITER = /\$\$|\\\(|\\\)|\\\[|\\\]|(?:^|[^\\$])\$(?=\S)|\$(?=$|[^\s$])/g
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function renderCommitted(content: string): Promise<void> {
  const model = buildMentionRender(content, ['owner-id'], {
    marker: MARKER,
    nameOf: () => '研究主持人',
  })
  await act(async () => {
    root.render(createElement(Markdown, {
      trust: 'chat',
      content: model.content,
      mentionMarker: MARKER,
    }))
    await Promise.resolve()
    await Promise.resolve()
  })
}
function assertCommittedFullProjection(): void {
  const markdown = container.querySelector<HTMLElement>('.gg-md')
  expect(markdown).not.toBeNull()
  const katex = markdown!.querySelectorAll('.katex')
  const annotations = markdown!.querySelectorAll('annotation[encoding="application/x-tex"]')
  expect(katex).toHaveLength(COMMITTED_RESEARCH_MATH_COUNT)
  expect(annotations).toHaveLength(COMMITTED_RESEARCH_MATH_COUNT)
  expect([...annotations].every((node) => (node.textContent ?? '').trim().length > 0)).toBe(true)
  const residual = markdown!.cloneNode(true) as HTMLElement
  residual.querySelectorAll('.katex, code, pre, script, style, math, annotation, button, svg, [hidden], [aria-hidden="true"], .sr-only')
    .forEach((node) => node.remove())
  expect((residual.textContent ?? '').match(RAW_DELIMITER) ?? []).toEqual([])
  expect(markdown!.textContent).toContain('COMMITTED_SUFFIX_PRESENT')
  expect(markdown!.textContent).toContain('LONG_MESSAGE_END')
  expect(markdown!.querySelector('[data-mention="true"]')?.textContent).toBe('@研究主持人')
  expect(markdown!.querySelector('[data-streamdown="table"]')).not.toBeNull()
  expect(markdown!.textContent).toContain('$literal$')
  expect(markdown!.textContent).toContain('$fenced-literal$')
  expect(
    markdown!.textContent?.includes('graph TD') || markdown!.querySelector('svg') !== null,
  ).toBe(true)
}
describe('Markdown committed research projection', () => {
  it('mounts a complete committed row as one settled 17-formula projection', async () => {
    await renderCommitted(COMMITTED_RESEARCH_FULL)
    assertCommittedFullProjection()
  })
  it('replaces an earlier prefix with the complete committed row without retaining the prefix DOM', async () => {
    await renderCommitted(COMMITTED_RESEARCH_PREFIX)
    expect(container.querySelectorAll('.katex')).toHaveLength(10)
    expect(container.textContent).toContain('$1/3')
    await renderCommitted(COMMITTED_RESEARCH_FULL)
    assertCommittedFullProjection()
  })
})
