/**
 * 折叠是不是真能用:真指针悬浮展开、里面的行点了收起整个菜单且动作生效,键盘同样走得到。
 * jsdom 的合成事件看不到 Base UI 的悬浮和两层菜单的开合,所以放在真浏览器里。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '@/styles/tokens.css'
import '@renderer/index.css'
import { Menu, MenuFold, MenuItem } from '@/components/ui/Menu'

let root: Root | null = null
beforeEach(() => page.viewport(1280, 800))
afterEach(() => { root?.unmount(); root = null })

function mount(rows: string[]) {
  const onClose = vi.fn()
  const onRow = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<Menu x={40} y={40} onClose={onClose}>
    <MenuItem data-testid="first" onClick={() => onRow('first')}>First</MenuItem>
    <MenuFold label="More" data-testid="fold">
      {rows.map((row) => <MenuItem key={row} data-testid={row} onClick={() => onRow(row)}>{row}</MenuItem>)}
    </MenuFold>
  </Menu>)
  return { onClose, onRow }
}

test('hovering the fold opens its rows beside it; a click runs the row and closes the whole menu', async () => {
  const { onClose, onRow } = mount(['a', 'b'])
  await expect.element(page.getByTestId('fold')).toBeVisible()
  expect(document.querySelector('[data-testid="a"]')).toBeNull()
  await userEvent.hover(page.getByTestId('fold'))
  await expect.element(page.getByTestId('b')).toBeVisible()
  const fold = page.getByTestId('fold').element().getBoundingClientRect()
  expect(page.getByTestId('b').element().getBoundingClientRect().left).toBeGreaterThanOrEqual(fold.right - 8)
  await userEvent.click(page.getByTestId('b'))
  expect(onRow).toHaveBeenCalledWith('b')
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
})

test('the keyboard reaches folded rows', async () => {
  const { onRow } = mount(['a', 'b'])
  await expect.element(page.getByTestId('fold')).toBeVisible()
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowRight}')
  await expect.element(page.getByTestId('a')).toBeVisible()
  await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-testid')).toBe('a'))
  await userEvent.keyboard('{ArrowLeft}')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="a"]')).toBeNull())
  await userEvent.keyboard('{ArrowRight}{Enter}')
  await vi.waitFor(() => expect(onRow).toHaveBeenCalledWith('a'))
})

test('a lone row stays in place and an empty fold draws nothing', async () => {
  mount(['only'])
  await expect.element(page.getByTestId('only')).toBeVisible()
  expect(document.querySelector('[data-testid="fold"]')).toBeNull()
  root?.unmount()
  mount([])
  await expect.element(page.getByTestId('first')).toBeVisible()
  expect(document.querySelector('[data-testid="fold"]')).toBeNull()
})

test('a phone has no hover and no room for a second layer: the rows stay flat', async () => {
  await page.viewport(390, 800)
  mount(['a', 'b'])
  await expect.element(page.getByTestId('a')).toBeVisible()
  await expect.element(page.getByTestId('b')).toBeVisible()
  expect(document.querySelector('[data-testid="fold"]')).toBeNull()
})
