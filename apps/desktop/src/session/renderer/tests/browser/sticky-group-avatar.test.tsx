import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GroupAvatarSlot } from '@/components/chat/StickyGroupAvatar'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => { root.unmount(); host.remove(); vi.restoreAllMocks() })

type Message = { id: string; height: number; prev: boolean; next: boolean }
const initial: Message[] = [
  { id: 'top', height: 90, prev: false, next: true },
  { id: 'middle', height: 100, prev: true, next: true },
  { id: 'tail', height: 80, prev: true, next: false },
  { id: 'single', height: 60, prev: false, next: false },
]
const render = (messages: Message[]) => root.render(
  <div data-scroll style={{ height: 180, overflow: 'auto', position: 'relative', width: 320 }}>
    <div role="list">
      {messages.map(message => <div role="listitem" data-row={message.id} key={message.id} style={{ display: 'flex', paddingTop: 12, paddingBottom: 16, gap: 8 }}>
        <GroupAvatarSlot wide={false} groupedWithPrev={message.prev} groupedWithNext={message.next}>
          <button data-avatar={message.id} style={{ width: 32, height: 32 }}>A</button>
        </GroupAvatarSlot>
        <div data-message-bubble-row style={{ width: 240, height: message.height }}>{message.id}</div>
      </div>)}
    </div>
  </div>)
const row = (id: string) => host.querySelector<HTMLElement>(`[data-row="${id}"]`)!
const bubble = (id: string) => row(id).querySelector<HTMLElement>('[data-message-bubble-row]')!
const layer = (id: string) => row(id).firstElementChild!.firstElementChild as HTMLElement
const spanMatches = (id: string, first: string) => {
  if (!row(id) || !row(first)) return false
  const expected = bubble(id).getBoundingClientRect().bottom - bubble(first).getBoundingClientRect().top
  return Math.abs(parseFloat(layer(id).style.height) - expected) < 0.5
}
const settled = (id: string, first: string) => until('the asynchronous avatar span matches its group', () => spanMatches(id, first))
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

it('keeps sticky avatars bounded by their own group while scrolling and resizing a message', async () => {
  render(initial)
  await settled('tail', 'top')
  await settled('single', 'single')
  const avatar = host.querySelector<HTMLElement>('[data-avatar="tail"]')!
  const scroll = host.querySelector<HTMLElement>('[data-scroll]')!
  expect(getComputedStyle(avatar.parentElement!).position).toBe('sticky')
  scroll.scrollTop = 150
  await frames()
  const bounds = avatar.getBoundingClientRect()
  expect(bounds.top).toBeGreaterThanOrEqual(bubble('top').getBoundingClientRect().top - 0.5)
  expect(bounds.bottom).toBeLessThanOrEqual(bubble('tail').getBoundingClientRect().bottom + 0.5)
  render(initial.map(message => message.id === 'middle' ? { ...message, height: 220 } : message))
  await settled('tail', 'top')
  await settled('single', 'single')
})

it('rebinds the group start when older history is prepended and when that history is removed', async () => {
  render(initial)
  await settled('tail', 'top')
  render([{ id: 'older', height: 110, prev: false, next: true }, ...initial.map(message => message.id === 'top' ? { ...message, prev: true } : message)])
  await settled('tail', 'older')
  render(initial)
  await settled('tail', 'top')
})

it('delivers resized geometry without calling a synchronous DOM rectangle query', async () => {
  render(initial)
  await settled('tail', 'top')
  const reads = vi.spyOn(Element.prototype, 'getBoundingClientRect')
  bubble('middle').style.height = '160px'
  await until('the browser delivered the resized group height', () => layer('tail').style.height === '386px')
  expect(reads).not.toHaveBeenCalled()
})
