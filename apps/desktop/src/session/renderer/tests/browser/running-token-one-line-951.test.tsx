import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { RunningBarSlot, RunningTokenBar, type RunningToken } from '@/components/RunningTokenBar'
import { ChatBottomDock } from '@/components/chat/ChatBottomDock'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import '@/i18n/registerAgentsCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'

// Real token, flex row, dock, ResizeObserver and Base UI popover; avatar drawing and message fetching
// do not own this geometry contract.
vi.mock('@/components/Avatar', () => ({ Avatar: () => <span style={{ display: 'inline-block', width: 16, height: 16, flexShrink: 0 }} /> }))
vi.mock('@/components/MessagePreviewCard', () => ({ MessagePreviewCard: () => null }))
vi.mock('@/platform', () => ({ platform: { kind: 'web' } }))

const VIEWPORT_HEIGHT = 800
let root: Root | null = null
let column: HTMLDivElement | null = null

const tokens = (count: number, mine: (index: number) => boolean): RunningToken[] => Array.from({ length: count }, (_, index) => ({
  id: `agent-${index}`, name: `Agent ${index} with a long task name`, avatarUrl: null, avatarSeed: String(index),
  stateKey: 'running', toolCount: 0, lastActiveAt: null, mine: mine(index),
}))

const shown = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
  .filter(element => getComputedStyle(element).visibility !== 'hidden' && element.getBoundingClientRect().width > 0)
const rowTops = () => new Set(shown('.rtb-bar > .rtb-tok, .rtb-bar > .rtb-more').map(element => Math.round(element.getBoundingClientRect().top)))
const panel = () => document.querySelector<HTMLElement>('.rtb-ov')
const composer = () => column!.querySelector<HTMLElement>('[data-composer-geometry]')!

async function mount(width: number, list: RunningToken[], onTokenClick = vi.fn()) {
  column!.style.width = `${width}px`
  const render = (items: RunningToken[]) => root!.render(
    <ChatBottomDock reserve={false} above={<RunningBarSlot>
      <RunningTokenBar tokens={items} previewChatId={null} onTokenClick={onTokenClick} />
    </RunningBarSlot>}>
      <textarea data-composer-geometry="" style={{ display: 'block', width: '100%', height: 110, resize: 'none', boxSizing: 'border-box' }} />
    </ChatBottomDock>,
  )
  render([])
  await until('the dock and composer are laid out', () => composer()?.getBoundingClientRect().height === 110)
  const original = composer().getBoundingClientRect()
  render(list)
  await until('the strip fits its one row', () => shown('.rtb-tok').length > 0 && rowTops().size === 1
    && shown('.rtb-tok').length + Number(column!.querySelector('.rtb-more')?.textContent?.slice(1) ?? 0) === list.length)
  return { original, render }
}

beforeEach(async () => {
  await page.viewport(1200, VIEWPORT_HEIGHT)
  await i18n.changeLanguage('en-US')
  document.body.style.margin = '0'
  column = document.createElement('div')
  column.className = 'gugu-skin'
  Object.assign(column.style, { position: 'fixed', left: '32px', bottom: '12px', height: '700px' })
  document.body.appendChild(column)
  root = createRoot(column)
})

afterEach(() => {
  root?.unmount()
  column?.remove()
  root = null
  column = null
})

describe('running strip: one row, +N opens a grouped, capped, scrolling panel', () => {
  for (const width of [320, 900]) for (const count of [1, 20, 60]) {
    it(`${width}px, ${count} agents`, async () => {
      const onTokenClick = vi.fn()
      const { original } = await mount(width, tokens(count, index => index % 3 === 0), onTokenClick)
      const inComposer = (element: HTMLElement) => {
        const box = element.getBoundingClientRect()
        expect(box.left).toBeGreaterThanOrEqual(original.left - 1)
        expect(box.right).toBeLessThanOrEqual(original.right + 1)
      }
      shown('.rtb-bar > .rtb-tok, .rtb-bar > .rtb-more').forEach(inComposer)
      expect(composer().getBoundingClientRect().top).toBe(original.top)

      const more = column!.querySelector<HTMLElement>('.rtb-more')
      if (!more) { expect(count).toBe(1); return }
      const collapsed = shown('.rtb-bar > .rtb-tok').map(element => element.dataset.messagePreviewTrigger!)
      const bar = column!.querySelector('.rtb-bar')!.getBoundingClientRect()
      await userEvent.hover(more)
      await until('the panel opens above the strip', () => (panel()?.getBoundingClientRect().height ?? 0) > 0
        && panel()!.closest('[data-slot="popover-positioner"]')?.getAttribute('data-side') === 'top')
      const popup = panel()!
      await Promise.all(popup.getAnimations().map(animation => animation.finished)) // the entry scale settles
      const box = popup.getBoundingClientRect()
      expect(Math.abs(box.width - bar.width)).toBeLessThanOrEqual(1)
      inComposer(popup)
      expect(box.bottom).toBeLessThanOrEqual(bar.top + 1)
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.height).toBeLessThanOrEqual(VIEWPORT_HEIGHT * 0.4 + 1)
      expect(getComputedStyle(popup).overflowY).toBe('auto')
      expect(composer().getBoundingClientRect().top).toBe(original.top)

      // Grouped: Mine first, then Others; every overflow agent appears exactly once, in its group.
      const groups = [...popup.querySelectorAll<HTMLElement>('[role="group"]')]
      const expanded = groups.flatMap(group => [...group.querySelectorAll<HTMLElement>('[data-message-preview-trigger]')])
      expect(new Set([...collapsed, ...expanded.map(element => element.dataset.messagePreviewTrigger!)]).size).toBe(count)
      expect(expanded).toHaveLength(count - collapsed.length)
      const mineIds = new Set(tokens(count, index => index % 3 === 0).filter(token => token.mine).map(token => token.id))
      const labels = groups.map(group => group.getAttribute('aria-label'))
      if (labels.length === 2) expect(labels).toEqual(['Mine', 'Others'])
      for (const group of groups) {
        const ids = [...group.querySelectorAll<HTMLElement>('[data-message-preview-trigger]')].map(element => element.dataset.messagePreviewTrigger!)
        expect(new Set(ids.map(id => mineIds.has(id))).size).toBe(1)
        if (labels.length === 2) expect(mineIds.has(ids[0])).toBe(group.getAttribute('aria-label') === 'Mine')
      }
      if (count === 60) expect(popup.scrollHeight).toBeGreaterThan(popup.clientHeight)

      const last = expanded.at(-1)!
      last.scrollIntoView({ block: 'nearest' })
      await until('the last overflow agent scrolls into the panel', () => {
        const chip = last.getBoundingClientRect(), viewport = popup.getBoundingClientRect()
        return chip.top >= viewport.top - 1 && chip.bottom <= viewport.bottom + 1
      })
      inComposer(last)
      await userEvent.hover(composer())
      await until('the panel collapses once the pointer leaves', () => !panel())
      await userEvent.hover(more)
      await until('the panel reopens', () => !!panel())
      const lastId = last.dataset.messagePreviewTrigger!
      await userEvent.click(panel()!.querySelector<HTMLElement>(`[data-message-preview-trigger="${lastId}"]`)!)
      expect(onTokenClick).toHaveBeenCalledWith(lastId)
      composer().focus() // picking an agent inserts its @ mention, which focuses the composer
      await userEvent.hover(composer())
      await until('the panel collapses after an agent was picked', () => !panel())
      expect(composer().getBoundingClientRect().top).toBe(original.top)
    })
  }

  it('draws no group names when every overflow agent has the same owner', async () => {
    await mount(320, tokens(20, () => false))
    await userEvent.hover(column!.querySelector<HTMLElement>('.rtb-more')!)
    await until('the panel opens', () => (panel()?.getBoundingClientRect().height ?? 0) > 0)
    expect(panel()!.querySelectorAll('[role="group"]')).toHaveLength(1)
    expect(panel()!.querySelector('.rtb-oh')).toBeNull()
  })

  it('phone: the same one row, and a tap on +N opens the panel', async () => {
    await page.viewport(390, VIEWPORT_HEIGHT)
    window.dispatchEvent(new Event('resize'))
    Object.assign(column!.style, { left: '0px' })
    const { original } = await mount(390, tokens(20, index => index < 5))
    expect(Math.abs(shown('.rtb-bar > .rtb-tok')[0].getBoundingClientRect().left - original.left)).toBeLessThanOrEqual(1)
    await userEvent.click(column!.querySelector<HTMLElement>('.rtb-more')!)
    await until('the tapped panel stays open', () => (panel()?.getBoundingClientRect().height ?? 0) > 0)
    expect(panel()!.querySelectorAll('[role="group"]')).toHaveLength(2)
  })
})
