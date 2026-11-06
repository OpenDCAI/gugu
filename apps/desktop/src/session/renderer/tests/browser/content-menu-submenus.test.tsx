/**
 * An App's menu with submenus (showContextMenu `items`), drawn by the host's ContentMenu on the shared Menu. Real pointer
 * and keys: one submenu open at a time, a submenu row opening never closes the menu around it, and the keyboard walks
 * in and out. Only leaves answer.
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { cdp, page, userEvent } from 'vitest/browser'
import '@/styles/tokens.css'
import '@renderer/index.css'
import { ContentMenu } from '@/components/ContentMenu'
import { appContextMenuOf } from '@/session/shared/extensions/app-context-menu'
import { until } from '../../../../../../../tests/support/awaitCondition'

let root: Root | null = null
afterEach(() => { root?.unmount(); root = null })

const menus = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
const row = (label: string) => menus().flatMap(menu => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]).find(item => item.textContent === label)!

async function show(x = 120) {
  await page.viewport(900, 600)
  const outcome: { action?: string | null } = {}
  const menu = appContextMenuOf({ x, y: 80, items: [
    { id: 'insert', label: 'Insert below', items: [{ id: 'i-table', label: 'Table' }, { id: 'i-quote', label: 'Quote' }] },
    { id: 'turn', label: 'Turn into', items: [{ id: 't-heading', label: 'Heading' }, { id: 't-quote', label: 'Quote' }] },
    { type: 'separator' },
    { id: 'delete', label: 'Delete' },
  ] })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const done = (action: string | null) => { outcome.action ??= action; root?.render(null) }
  root.render(<ContentMenu menu={{ ...menu, requestId: 'r' }} onClose={() => done(null)} onAction={done} />)
  return outcome
}

// Rows are measured once the popups have settled (their opening motion scales them).
const settled = () => menus().every(menu => !menu.hasAttribute('data-starting-style') && menu.getAnimations().every(a => a.playState !== 'running'))
// The pointer at a point of this page (the test page is framed: map to the top window as the browser sees it).
async function pointerAt(x: number, y: number) {
  for (let current: Window = window; current.frameElement; current = current.parent) {
    const frame = current.frameElement as HTMLElement, box = frame.getBoundingClientRect()
    const scale = box.width / frame.offsetWidth
    x = box.left + (frame.clientLeft + x) * scale
    y = box.top + (frame.clientTop + y) * scale
  }
  const session = cdp() as unknown as { send: (method: string, params: object) => Promise<unknown> }
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}
let at = { x: 1, y: 1 }
// A person's pointer travels: a path of moves, not a jump.
async function travel(x: number, y: number) {
  const from = at
  for (let step = 1; step <= 8; step++) await pointerAt(from.x + (x - from.x) * step / 8, from.y + (y - from.y) * step / 8)
  at = { x, y }
}
async function hover(label: string, along = 0.5) {
  await until('the menus have settled', settled)
  const box = row(label).getBoundingClientRect()
  await travel(box.left + box.width * along, box.top + box.height / 2)
}

it('keeps one submenu open: the pointer moving from Insert below to Turn into swaps them, and the menu stays', async () => {
  const outcome = await show()
  await until('the menu is drawn', () => menus().length === 1)
  await hover('Insert below')
  await until('Insert below opens its submenu', () => menus().length === 2 && row('Insert below').getAttribute('aria-expanded') === 'true')
  // On the way to the open submenu the pointer crosses Turn into's far end: that is not a choice of Turn into.
  const table = row('Table').getBoundingClientRect()
  await travel(table.left + 4, table.top + table.height / 2)
  expect(row('Insert below').getAttribute('aria-expanded')).toBe('true')
  await hover('Insert below', 0.3)
  // Down to the next row is a choice.
  await hover('Turn into', 0.3)
  await until('Turn into replaces it', () => menus().length === 2 && row('Turn into').getAttribute('aria-expanded') === 'true')
  expect(row('Insert below').getAttribute('aria-expanded')).not.toBe('true')
  expect([...menus()[1]!.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Heading', 'Quote'])
  expect(outcome.action).toBeUndefined()
  await userEvent.click(row('Quote'))
  await until('the leaf answers with its own id', () => outcome.action === 't-quote')
})

it('walks by keyboard: ↓ to Turn into, → in, ← back out, Enter picks; Escape closes one level', async () => {
  await travel(1, 1)
  const outcome = await show()
  await until('the menu takes the keyboard', () => menus()[0]?.contains(document.activeElement) === true)
  await userEvent.keyboard('{ArrowDown}')
  await until('↓ starts on the first row', () => document.activeElement?.textContent, text => text === 'Insert below')
  await userEvent.keyboard('{ArrowDown}')
  await until('↓ reaches Turn into', () => document.activeElement === row('Turn into'))
  await userEvent.keyboard('{ArrowRight}')
  await until('→ opens it on its first row', () => menus().length === 2 && document.activeElement === row('Heading'))
  await userEvent.keyboard('{ArrowLeft}')
  await until('← closes it and returns to its row', () => menus().length === 1 && document.activeElement === row('Turn into'))
  await userEvent.keyboard('{ArrowRight}')
  await until('→ opens it again', () => document.activeElement === row('Heading'))
  await userEvent.keyboard('{Escape}')
  await until('Escape closes the submenu only, back on its row', () => menus().length === 1 && document.activeElement === row('Turn into'))
  expect(outcome.action).toBeUndefined()
  await userEvent.keyboard('{ArrowRight}')
  await until('→ opens it once more', () => document.activeElement === row('Heading'))
  await userEvent.keyboard('{Enter}')
  await until('Enter on the leaf answers', () => outcome.action === 't-heading')
})

it('opens a submenu on the other side when the window edge leaves no room', async () => {
  await show(640)
  await until('the menu is drawn', () => menus().length === 1)
  await hover('Insert below')
  await until('Insert below opens its submenu', () => menus().length === 2)
  await until('the submenus have settled', settled)
  const parent = menus()[0]!.getBoundingClientRect(), child = menus()[1]!.getBoundingClientRect()
  // Flipped: it sits left of the menu (its rows overlapping the edge by the surface's few-pixel inset), inside the window.
  expect(child.right).toBeLessThanOrEqual(window.innerWidth)
  expect(child.left).toBeLessThan(parent.left)
  expect(child.right).toBeLessThanOrEqual(parent.left + 8)
})
