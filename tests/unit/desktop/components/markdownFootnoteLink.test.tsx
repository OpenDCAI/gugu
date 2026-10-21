// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Markdown } from '../../../../apps/desktop/src/components/markdown/Markdown'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const scrolled: Element[] = []
const scrollOptions: unknown[] = []
const original = Element.prototype.scrollIntoView

beforeEach(() => {
  // jsdom has no CSS.escape; the handler only puts the id inside a quoted attribute selector.
  globalThis.CSS ??= { escape: (value: string) => value.replace(/["\\]/g, '\\$&') } as typeof CSS
  scrolled.length = 0
  scrollOptions.length = 0
  Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
    scrolled.push(this)
    scrollOptions.push(options)
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Element.prototype.scrollIntoView = original
})

// 文件预览里点脚注一动不动:sanitize 给每个 id 加了 `user-content-`,链接里的片段却是 GFM 写的原样。
it('a footnote reference scrolls to its note, and the note back to the reference', async () => {
  await act(async () => {
    root.render(createElement(Markdown, { trust: 'document', content: 'See the note.[^n]\n\n[^n]: The note body.' }))
    await Promise.resolve()
  })
  const reference = container.querySelector<HTMLAnchorElement>('a[data-footnote-ref]')!
  await act(async () => reference.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  expect(scrolled.at(-1)?.textContent).toContain('The note body.')

  const back = container.querySelector<HTMLAnchorElement>('a[data-footnote-backref]')!
  await act(async () => back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  expect(scrolled.at(-1)).toBe(reference)
  expect(scrolled).toHaveLength(2)
  expect(scrollOptions).toEqual([{ block: 'nearest' }, { block: 'nearest' }])
})

// #6950: headings had no id, so a `#section` link in a file preview went nowhere. They carry GitHub's anchors now —
// prefixed by the sanitizer like every id — and a link to one brings that heading to the top.
it('a heading anchor link lands its heading at the top — CJK (percent-encoded) and a repeated heading too', async () => {
  const content = [
    '[to install](#install-steps) [to cjk](#%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98) [to second](#install-steps-1)',
    '## Install Steps',
    'one',
    '### 中文 标题',
    'two',
    '## Install Steps',
    'three',
  ].join('\n\n')
  await act(async () => {
    root.render(createElement(Markdown, { trust: 'document', content }))
    await Promise.resolve()
  })
  const headings = [...container.querySelectorAll('h2, h3')].map((h) => h.id)
  expect(headings).toEqual(['user-content-install-steps', 'user-content-中文-标题', 'user-content-install-steps-1'])
  for (const [text, id] of [
    ['to install', 'user-content-install-steps'],
    ['to cjk', 'user-content-中文-标题'],
    ['to second', 'user-content-install-steps-1'],
  ]) {
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === text)!
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(scrolled.at(-1)?.id).toBe(id)
    expect(scrollOptions.at(-1)).toEqual({ block: 'start' })
  }
})
