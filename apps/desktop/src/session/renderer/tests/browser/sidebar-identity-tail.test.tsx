/**
 * 身份卡文件夹那一格:放不下时截的是前面,最后一段目录名整段露着(#633 跟进,1046.1 真机验收)。
 *
 * 真机上 `~/Library/Application Support/咕咕 Beta/task-home` 读成了「~/Library/Applicat… /task-ho…」——
 * 两截一起被压。**为什么必须真 Chromium**:谁被截、截多少是 flex 排版的结果,jsdom 没有排版。
 * 判据直接量结尾那一截有没有被截(scrollWidth > clientWidth 即有省略号)。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { TailValue } from '@renderer/features/sidebar/sidebar-identity-tail'

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(async () => {
  await import('@renderer/index.css')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  root?.unmount()
  host?.remove()
  root = null
  host = null
})

/** 放进一格固定宽的栏里(与卡上的值那一格同样是 grid 里的 min-w-0 一列)。 */
async function render(text: string, width: number) {
  root!.render(
    <div style={{ width }} className="grid min-w-0 grid-cols-1">
      <TailValue text={text} className="col-start-1 row-start-1" />
    </div>
  )
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  const [head, tail] = Array.from(host!.querySelectorAll<HTMLElement>('span > span'))
  return { head, tail, cut: (el: HTMLElement) => el.scrollWidth > el.clientWidth + 0.5 }
}

it('a long path keeps its last directory whole and cuts only the front', async () => {
  const { head, tail, cut } = await render('~/Library/Application Support/咕咕 Beta/task-home', 220)
  expect(tail.textContent).toBe('/task-home')
  expect(cut(tail)).toBe(false)
  // 阳性对照:前面那截确实放不下、被截了 —— 读法没坏,上一句不是因为什么都没截才过。
  expect(cut(head)).toBe(true)
})

it('a path that fits is not cut anywhere', async () => {
  const { head, tail, cut } = await render('~/Codebase/shop', 220)
  expect(cut(head)).toBe(false)
  expect(cut(tail)).toBe(false)
})

it('a last directory wider than the whole cell is itself cut instead of overflowing the card', async () => {
  const { tail, cut } = await render('~/x/' + 'very-long-directory-name-'.repeat(4), 160)
  expect(cut(tail)).toBe(true)
  expect(tail.getBoundingClientRect().width).toBeLessThanOrEqual(160.5)
})
