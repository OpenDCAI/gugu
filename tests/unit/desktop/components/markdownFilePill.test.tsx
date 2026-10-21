// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '../../../../apps/desktop/src/components/markdown/Markdown'
import { filePillText, filePillToken } from '../../../../apps/desktop/src/components/markdown/filePills'
import { groupFileLink, parseGroupFileLink } from '@gugu/core/shared/ui/fileLink'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * App 引用 pill in a chat bubble (owner 10-14): `@[label](gugu-file://<id>?v=…#<at>)` is drawn as the transcript's file
 * pill — the `@` gone, the label in a chip, the version it was picked on on hover — and its click is its link's.
 */

const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
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
async function render(content: string, onOpenLink: (href: string) => boolean = () => true): Promise<void> {
  await act(async () => {
    root.render(createElement(Markdown, { trust: 'chat', content, onOpenLink }))
    await Promise.resolve()
  })
}

describe('a pill pointing at a group file, in a chat bubble', () => {
  it('is drawn as the file pill: no `@` left, its label, the picked version on hover; its click is the link’s', async () => {
    const onOpenLink = vi.fn(() => true)
    await render(`把这处改成蓝色 @[演示稿 · 第 3 页 · 标题](gugu-file://${ITEM}?v=7#slide=3&shape=12)`, onOpenLink)
    const pill = container.querySelector<HTMLAnchorElement>('a.gg-file-pill')!
    expect(pill).not.toBeNull()
    expect(pill.classList.contains('gg-md-mention')).toBe(true)
    expect(pill.textContent).toBe('演示稿 · 第 3 页 · 标题')
    // The words come from the messaging strings (filePill.picked); the label leads, the version note follows.
    expect(pill.title.startsWith('演示稿 · 第 3 页 · 标题 · ')).toBe(true)
    expect(container.textContent).toBe('把这处改成蓝色 演示稿 · 第 3 页 · 标题')
    await act(async () => pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(onOpenLink).toHaveBeenCalledWith(pill.getAttribute('href'))
    expect(decodeURI(pill.getAttribute('href')!)).toBe(`gugu-file://${ITEM}?v=7#slide=3&shape=12`)
  })

  it('control: a group file’s plain link (no `@`) stays a link, and an `@` before a web link stays text', async () => {
    await render(`见 [演示稿.pptx](gugu-file://${ITEM}) 和 @[网站](https://example.com)`)
    expect(container.querySelector('a.gg-file-pill')).toBeNull()
    expect(container.textContent).toContain('@网站')
  })

  // 155 10-15: the host encodes the App's place; through the real renderer it comes back exactly — `%`, a space, quotes.
  it('the place the App wrote comes back exactly from the bubble’s href, and copies back to the same token', async () => {
    const at = { range: "'R&D 预算'!A1:D4", note: '100% (done)', t: '&lt;' }
    const token = filePillText({ label: '预算 · A1:D4', link: groupFileLink(ITEM, { version: 2, at }) })
    await render(`看 ${token}`)
    const pill = container.querySelector<HTMLAnchorElement>('a.gg-file-pill')!
    expect(pill).not.toBeNull()
    expect(parseGroupFileLink(pill.getAttribute('href')!)).toEqual({ itemId: ITEM, version: 2, at })
    expect(filePillToken(pill.textContent!, pill.getAttribute('href')!)).toBe(token)
  })

  it('copied out of a bubble it is its token again — the href decoded back to what the message wrote', () => {
    const href = encodeURI(`gugu-file://${ITEM}?v=2#range=销售!B2:D4`)
    expect(filePillToken('销售!B2:D4 · 3×3', href)).toBe(`@[销售!B2:D4 · 3×3](gugu-file://${ITEM}?v=2#range=销售!B2:D4)`)
    expect(filePillToken('图 2]', `gugu-file://${ITEM}`)).toBe(`@[图 2\\]](gugu-file://${ITEM})`)
  })
})
