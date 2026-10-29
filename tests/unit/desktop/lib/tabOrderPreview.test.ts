// @vitest-environment jsdom
import { act, createElement, useRef } from 'react'
import type { DndMonitorListener, DragMoveEvent } from '@dnd-kit/core'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { createTabProvider, createTabRegistry } from '../../../../apps/desktop/src/session/renderer/features/tabs/core/tab-provider-registry'
import { PaneLayoutStore } from '../../../../apps/desktop/src/session/renderer/features/tabs/pane-layout-store'
import { useTabOrderPreview } from '../../../../apps/desktop/src/session/renderer/features/tabs/tab-bar/use-tab-order-preview'
import { tabDropTarget } from '../../../../apps/desktop/src/session/renderer/features/tabs/tab-bar/tab-motion'

const wire = vi.hoisted(() => ({ monitor: null as DndMonitorListener | null }))
vi.mock('@dnd-kit/core', async original => ({
  ...await original<object>(), useDndMonitor: (monitor: DndMonitorListener) => { wire.monitor = monitor },
}))

let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); vi.restoreAllMocks() })

async function setup() {
  harness = createReactHarness()
  const provider = createTabProvider({ kind: 'fixture', mount: 'multi', resourceKey: (state: { i: number }) => String(state.i),
    initialize: () => ({ dispose() {} }), dispose() {},
    TabContent: () => null, TabBarItem: () => null, TabBarItemDragPreview: () => null,
  })
  const layout = new PaneLayoutStore(createTabRegistry([provider]),
    { viewId: 'preview', place: { kind: 'session', sessionId: 'preview', projectId: 'preview' } })
  for (let i = 0; i < 3; i++) layout.open('fixture', { i }, { activate: false })
  const pane = layout.groups[0].pane, [a, b, c] = pane.tabOrder
  const rect = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 40, width, height: 40 } as DOMRect)
  function Probe() {
    const scroller = useRef<HTMLDivElement>(null)
    const order = useTabOrderPreview(pane, scroller)
    return createElement('div', { ref: (node: HTMLDivElement | null) => {
      scroller.current = node
      if (node) node.getBoundingClientRect = () => rect(0, 300)
    } }, ...order.map((tabId, i) => createElement('div', { key: tabId, className: 'session-tab-slot', 'data-tabid': tabId,
      ref: (node: HTMLDivElement | null) => { if (node) node.getBoundingClientRect = () => rect(i * 100, 100) },
    })))
  }
  await harness.render(createElement(Probe))
  const data: { tabReorderTarget?: string } = {}
  const event = (left: number): DragMoveEvent => ({
    active: { id: b, data: { current: data }, rect: { current: { initial: rect(100, 100), translated: rect(left, 100) } } },
    activatorEvent: new MouseEvent('pointerdown', { clientX: 150, clientY: 20 }), delta: { x: left - 100, y: 0 },
    over: { id: c, rect: rect(200, 100), disabled: false, data: { current: {} } }, collisions: null,
  })
  await act(() => wire.monitor!.onDragStart!(event(100)))
  const shown = () => [...harness.container.querySelectorAll<HTMLElement>('.session-tab-slot')].map(node => node.dataset.tabid)
  return { layout, pane, a, b, c, event, shown }
}

it('drops at the committed preview when another drag move is still batched', async () => {
  const { layout, pane, a, b, c, event, shown } = await setup()
  await act(() => {
    wire.monitor!.onDragMove!(event(210))
    expect(shown()).toEqual([a, b, c])
    expect(tabDropTarget(event(210))).toBe(b)
  })
  expect(shown()).toEqual([a, c, b])
  expect(tabDropTarget(event(210))).toBe(c)
  await act(() => {
    const move = event(0)
    wire.monitor!.onDragMove!(move)
    expect(shown()).toEqual([a, c, b])
    layout.handleDragEnd(b, tabDropTarget(move)!)
    wire.monitor!.onDragEnd!(move)
  })
  expect(pane.tabOrder).toEqual([a, c, b])
  expect(shown()).toEqual(pane.tabOrder)
})

it('keeps external drop routing and restores the visible target on re-entry', async () => {
  const { a, b, c, event, shown } = await setup()
  await act(() => wire.monitor!.onDragMove!(event(210)))
  await act(() => wire.monitor!.onDragMove!(event(400)))
  expect(shown()).toEqual([a, b, c])
  expect(tabDropTarget({ ...event(400), over: { ...event(400).over!, id: 'other-pane' } })).toBe('other-pane')
  await act(() => {
    wire.monitor!.onDragMove!(event(210))
    expect(shown()).toEqual([a, b, c])
    expect(tabDropTarget(event(210))).toBe(b)
  })
  expect(shown()).toEqual([a, c, b])
  expect(tabDropTarget(event(210))).toBe(c)
})
