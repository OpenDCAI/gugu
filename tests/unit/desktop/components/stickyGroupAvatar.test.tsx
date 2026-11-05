// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GroupAvatarSlot } from '../../../../apps/desktop/src/components/chat/StickyGroupAvatar'
import { createReactHarness } from '../../../support/testHarness'

type ResizeRecord = { report: () => void; targets: Element[]; disconnect: () => void }
type PositionRecord = { report: (entries: IntersectionObserverEntry[]) => void; targets: Element[]; disconnect: () => void }
let harness: ReturnType<typeof createReactHarness>
let resizes: ResizeRecord[]
let positions: PositionRecord[]
beforeEach(() => {
  harness = createReactHarness()
  resizes = []; positions = []
  vi.stubGlobal('ResizeObserver', class {
    record: ResizeRecord
    constructor(report: () => void) { this.record = { report, targets: [], disconnect: vi.fn() }; resizes.push(this.record) }
    observe(target: Element) { this.record.targets.push(target) }
    unobserve(target: Element) { this.record.targets = this.record.targets.filter(item => item !== target) }
    disconnect() { this.record.disconnect() }
  })
  vi.stubGlobal('IntersectionObserver', class {
    record: PositionRecord
    constructor(report: PositionRecord['report']) { this.record = { report, targets: [], disconnect: vi.fn() }; positions.push(this.record) }
    observe(target: Element) { this.record.targets.push(target) }
    disconnect() { this.record.disconnect() }
  })
})
afterEach(async () => { await harness.cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const row = (id: string, before: boolean, after: boolean) => createElement('div', { role: 'listitem', 'data-row': id },
  createElement(GroupAvatarSlot, { wide: false, groupedWithPrev: before, groupedWithNext: after, children: createElement('button', null, id) }),
  createElement('div', { 'data-message-bubble-row': '' }, id))
const render = (...rows: ReturnType<typeof row>[]) => harness.render(createElement('div', { role: 'list' }, ...rows))
const rect = (target: Element, top: number, bottom: number): IntersectionObserverEntry => ({
  target, time: 1, isIntersecting: false, intersectionRatio: 0, rootBounds: null,
  boundingClientRect: { top, bottom, left: 0, right: 32, width: 32, height: bottom - top, x: 0, y: top, toJSON: () => ({}) },
  intersectionRect: { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) },
})
const tail = (id = 'last') => harness.container.querySelector<HTMLElement>(`[data-row="${id}"]`)!
const slot = (id?: string) => tail(id).firstElementChild as HTMLElement
const layer = (id?: string) => slot(id).firstElementChild as HTMLElement

it('does not synchronously read layout when the message list resizes', async () => {
  await render(row('first', false, true), row('last', true, false))
  const reads = vi.spyOn(Element.prototype, 'getBoundingClientRect')
  resizes.forEach(observer => observer.report())
  expect(reads).not.toHaveBeenCalled()
  expect(layer().style.height).toBe('')
})

it('uses one complete asynchronous sample and ignores replaced or disposed observers', async () => {
  await render(row('first', false, true), row('last', true, false))
  const first = harness.container.querySelector('[data-row="first"] [data-message-bubble-row]')!
  const own = tail().querySelector('[data-message-bubble-row]')!
  const old = positions.at(-1)!
  resizes[0].report()
  const current = positions.at(-1)!
  expect(old.disconnect).toHaveBeenCalledOnce()
  old.report([rect(first, 0, 1000), rect(own, 0, 1000), rect(slot(), 0, 1000)])
  expect(layer().style.height).toBe('')
  current.report([rect(first, 20, 40), rect(own, 80, 110), rect(slot(), 70, 120)])
  expect(layer().style.bottom).toBe('10px')
  expect(layer().style.height).toBe('90px')
  expect(current.disconnect).toHaveBeenCalledOnce()
  const detachedLayer = layer()
  await harness.render(null)
  current.report([rect(first, 0, 999), rect(own, 0, 999), rect(slotElement(), 0, 999)])
  expect(detachedLayer.style.height).toBe('90px')
  expect(resizes[0].disconnect).toHaveBeenCalledOnce()
  function slotElement() { return detachedLayer.parentElement! }
})

it('keeps a single-message group inside its own bubble instead of the previous group', async () => {
  await render(row('first', false, true), row('last', true, false), row('single', false, false))
  const own = tail('single').querySelector('[data-message-bubble-row]')!
  const current = positions.find(observer => observer.targets.includes(slot('single')))!
  expect(current.targets).toEqual(expect.arrayContaining([own, slot('single')]))
  expect(current.targets).toHaveLength(2)
  current.report([rect(own, 200, 250), rect(slot('single'), 190, 270)])
  expect(layer('single').style.bottom).toBe('20px')
  expect(layer('single').style.height).toBe('50px')
})
