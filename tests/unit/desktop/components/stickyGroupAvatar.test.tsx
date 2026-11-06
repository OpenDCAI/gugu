// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupAvatarSlot } from '../../../../apps/desktop/src/components/chat/StickyGroupAvatar'
import { createReactHarness } from '../../../support/testHarness'

const observers: { callback: ResizeObserverCallback; targets: Set<Element>; initial: Set<Element> }[] = []
let harness: ReturnType<typeof createReactHarness>
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    record: typeof observers[number]
    constructor(callback: ResizeObserverCallback) { this.record = { callback, targets: new Set(), initial: new Set() }; observers.push(this.record) }
    observe(target: Element) { if (!this.record.targets.has(target)) this.record.initial.add(target); this.record.targets.add(target) }
    unobserve(target: Element) { this.record.targets.delete(target); this.record.initial.delete(target) }
    disconnect() { this.record.targets.clear(); this.record.initial.clear() }
  })
})
beforeEach(() => { harness = createReactHarness() })
afterEach(async () => { await harness.cleanup(); vi.restoreAllMocks() })
afterAll(() => { vi.unstubAllGlobals() })

function row(id: string, previous = false, next = false, wide = false) {
  return createElement('div', { role: 'listitem', 'data-row': id, key: id },
    createElement(GroupAvatarSlot, { wide, groupedWithPrev: previous, groupedWithNext: next, children: id }),
    createElement('div', { 'data-message-bubble-row': '' }, id))
}

async function resize(targets: Element[]) {
  await act(async () => {
    for (const observer of observers) {
      const entries = [...new Set([...targets, ...observer.initial])].filter(target => observer.targets.has(target)).map(target => ({ target }) as ResizeObserverEntry)
      observer.initial.clear()
      if (entries.length) observer.callback(entries, {} as ResizeObserver)
    }
  })
}

describe('sticky group avatar geometry', () => {
  it('reads both conversation panels before writing any avatar layer, and keeps each group within its bubbles', async () => {
    await harness.render(createElement('div', null,
      createElement('div', { 'data-list': 'group' }, row('single'), row('start', false, true), row('end', true)),
      createElement('div', { 'data-list': 'topic' }, row('topic', false, false, true))))
    const events: string[] = []
    const coordinates: Record<string, [number, number, number]> = { single: [10, 40, 48], start: [60, 80, 88], end: [90, 130, 142], topic: [20, 70, 76] }
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = this.closest('[data-row]')!.getAttribute('data-row')!
      events.push(`read:${id}`)
      const [top, bottom, slotBottom] = coordinates[id]
      return { top, bottom: this.hasAttribute('data-message-bubble-row') ? bottom : slotBottom } as DOMRect
    })
    const layers = [...harness.container.querySelectorAll<HTMLElement>('[data-row] > .relative > div')]
    for (const layer of layers) for (const property of ['bottom', 'height'] as const) {
      let prototype = Object.getPrototypeOf(layer.style)
      while (!Object.hasOwn(prototype, property)) prototype = Object.getPrototypeOf(prototype)
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property)!
      Object.defineProperty(layer.style, property, { configurable: true, get: () => descriptor.get!.call(layer.style), set(value: string) {
        events.push(`write:${property}`); descriptor.set!.call(layer.style, value)
      } })
    }
    expect(layers.map(layer => layer.style.height)).toEqual(['', '', ''])
    await resize([...harness.container.querySelectorAll('[data-list], [data-row]')])
    expect(events.filter(event => event.startsWith('read:'))).toHaveLength(9)
    expect(events.slice(events.findIndex(event => event.startsWith('write:'))).every(event => event.startsWith('write:'))).toBe(true)
    expect(layers.map(layer => [layer.style.bottom, layer.style.height])).toEqual([['8px', '30px'], ['12px', '70px'], ['6px', '50px']])
    expect(harness.container.querySelector('[data-row="topic"] > div')?.className).toContain('w-[44px]')

    coordinates.end = [90, 160, 172]
    await resize([harness.container.querySelector('[data-list="group"]')!])
    expect(layers[1].style.height).toBe('100px')
    expect(layers[2].style.height).toBe('50px')
  })

  it('keeps observing a list until its last avatar leaves and updates grouping on reused rows', async () => {
    const render = (second: boolean, grouped: boolean) => harness.render(createElement('div', { 'data-list': '' },
      row('start', false, grouped), second && row('end', grouped)))
    await render(true, true)
    const list = harness.container.querySelector('[data-list]')!
    const active = () => observers.filter(observer => observer.targets.has(list))
    expect(active()).toHaveLength(1)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const start = this.closest('[data-row]')!.getAttribute('data-row') === 'start'
      return { top: start ? 10 : 50, bottom: start ? 40 : 80 } as DOMRect
    })
    await resize([list])
    expect(harness.container.querySelector<HTMLElement>('[data-row="end"] .absolute')!.style.height).toBe('70px')
    await render(true, false)
    // The list can keep its dimensions when grouping changes; new avatar rows still get their initial delivery.
    await resize([])
    expect(harness.container.querySelector<HTMLElement>('[data-row="end"] .absolute')!.style.height).toBe('30px')
    await render(false, false)
    expect(active()).toHaveLength(1)
    await resize([list])
    await render(true, false)
    await resize([])
    expect(harness.container.querySelector<HTMLElement>('[data-row="end"] .absolute')!.style.height).toBe('30px')
    await harness.render(null)
    expect(active()).toHaveLength(0)
    expect(observers.every(observer => observer.targets.size === 0)).toBe(true)
    await resize([list])
  })
})
