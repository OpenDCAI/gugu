// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isConversationViewportAtBottom,
  resolveConversationRestoreLocation,
  selectConversationViewportAnchor,
  useConversationScrollMemory,
} from '../../../../apps/desktop/src/components/chat/useConversationScrollMemory'
import { publishActiveChatWillChange } from '../../../../apps/desktop/src/store/activeChatTransition'
import { resetAuthSessionBoundary } from '../../../../apps/desktop/src/lib/authSessionLoss'

beforeEach(() => resetAuthSessionBoundary())

describe('conversation scroll memory', () => {
  it('keeps the live anchor when another React root removes the slot before the portal ref exits', async () => {
    const carrier = document.createElement('div')
    const host = document.createElement('div')
    document.body.append(carrier, host)
    const slotRoot = createRoot(carrier)
    const portalRoot = createRoot(host)
    let slot: HTMLDivElement | null = null
    let memory: ReturnType<typeof useConversationScrollMemory> | null = null
    const setFollowingTail = vi.fn()
    const isAtBottomRef = { current: true }
    function Harness() {
      memory = useConversationScrollMemory({ chatId: 'slot-chat', activationKey: 'slot-chat', enabled: true,
        messageIds: ['older', 'anchor', 'newer'], isAtBottomRef, setFollowingTail })
      return createPortal(createElement('div', { ref: memory.setScrollerRef },
        createElement('div', { 'data-msg-id': 'anchor' })), slot!)
    }
    try {
      await act(async () => { slotRoot.render(createElement('div', { ref: (element: HTMLDivElement | null) => { slot = element } })) })
      await act(async () => { portalRoot.render(createElement(Harness)) })
      const scroller = slot!.firstElementChild as HTMLElement
      const row = scroller.firstElementChild as HTMLElement
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, get: () => scroller.isConnected ? 2_000 : 0 },
        clientHeight: { configurable: true, get: () => scroller.isConnected ? 800 : 0 },
        scrollTop: { configurable: true, writable: true, value: 700 },
      })
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 900 } as DOMRect)
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: 84, bottom: 160 } as DOMRect)
      await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
      await act(async () => { slotRoot.render(null) })
      expect(scroller.isConnected).toBe(false)
      expect(scroller.scrollHeight, 'the slot root has already removed the live geometry').toBe(0)
      expect(memory!.scrollerRef.current, 'the portal has not received its ref exit yet').toBe(scroller)
      await act(async () => { portalRoot.render(null) })
      await act(async () => { slotRoot.render(createElement('div', { ref: (element: HTMLDivElement | null) => { slot = element } })) })
      await act(async () => { portalRoot.render(createElement(Harness)) })
      expect(memory!.openLocation()).toEqual({ index: 1, align: 'start', offset: 16 })
      expect(memory!.prepareForSavedPosition()).toBe(true)
    } finally {
      await act(async () => { portalRoot.unmount(); slotRoot.unmount() })
      carrier.remove(); host.remove(); vi.restoreAllMocks()
    }
  })
  it('reads bottom state from the current viewport geometry', () => {
    expect(isConversationViewportAtBottom(
      { scrollHeight: 2_000, scrollTop: 1_120, clientHeight: 800 },
      80,
    )).toBe(true)
    expect(isConversationViewportAtBottom(
      { scrollHeight: 2_000, scrollTop: 700, clientHeight: 800 },
      80,
    )).toBe(false)
  })

  it('selects the first visible message and keeps its viewport-relative offset', () => {
    expect(selectConversationViewportAnchor(
      { top: 100, bottom: 500 },
      [
        { id: 'above', top: 20, bottom: 90 },
        { id: 'anchor', top: 84, bottom: 160 },
        { id: 'later', top: 160, bottom: 240 },
      ],
    )).toEqual({ messageId: 'anchor', offset: -16 })
  })

  it('restores through the current list data index rather than saved scrollTop pixels', () => {
    expect(resolveConversationRestoreLocation(
      { atBottom: false, messageId: 'm2', offset: 18 },
      ['m1', 'm2', 'm3'],
    )).toEqual({ index: 1, offset: -18 })
  })

  it('waits when the anchor is not in the current message window', () => {
    expect(resolveConversationRestoreLocation(
      { atBottom: false, messageId: 'missing', offset: 0 },
      ['m1', 'm2'],
    )).toBeNull()
    expect(resolveConversationRestoreLocation(
      { atBottom: true },
      ['m1', 'm2'],
    )).toBeNull()
  })

  it('abandons a missing anchor after one activation deadline despite message-window churn', async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const isAtBottomRef = { current: true }
    const setFollowingTail = vi.fn()
    let memory: ReturnType<typeof useConversationScrollMemory> | null = null

    function Harness({ chatId, messageIds, rowId }: {
      chatId: string
      messageIds: string[]
      rowId: string
    }) {
      memory = useConversationScrollMemory({
        chatId,
        activationKey: chatId,
        enabled: true,
        messageIds,
        isAtBottomRef,
        setFollowingTail,
      })
      return createElement('div', { ref: memory.setScrollerRef },
        createElement('div', { 'data-msg-id': rowId }))
    }

    try {
      await act(async () => {
        root.render(createElement(Harness, { chatId: 'chat-a', messageIds: ['anchor'], rowId: 'anchor' }))
      })
      const scroller = container.firstElementChild as HTMLElement
      const row = scroller.firstElementChild as HTMLElement
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 2_000 },
        scrollTop: { configurable: true, writable: true, value: 700 },
        clientHeight: { configurable: true, value: 800 },
      })
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 900 } as DOMRect)
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: 84, bottom: 160 } as DOMRect)

      act(() => publishActiveChatWillChange('chat-a', 'chat-b'))
      await act(async () => {
        root.render(createElement(Harness, { chatId: 'chat-b', messageIds: ['b1'], rowId: 'b1' }))
      })
      await act(async () => {
        root.render(createElement(Harness, { chatId: 'chat-a', messageIds: ['newer'], rowId: 'newer' }))
      })

      expect(memory!.prepareForSavedPosition()).toBe(true)
      expect(memory!.isPreservingPosition()).toBe(true)
      for (let second = 1; second <= 4; second += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
        await act(async () => {
          root.render(createElement(Harness, {
            chatId: 'chat-a',
            messageIds: [`newer-${second}`],
            rowId: `newer-${second}`,
          }))
        })
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })

      expect(error).toHaveBeenCalledWith(
        '[conversation-scroll] saved message anchor is not in the loaded window',
        { chatId: 'chat-a', messageId: 'anchor' },
      )
      expect(memory!.isPreservingPosition()).toBe(false)
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  // @@@6595 切回读到一半的会话:列表挂载时在第一次绘制之前就落在那一行(openLocation → initialTopMostItemIndex),
  // 恢复逻辑只核对偏移(内容晚到撑高时补一次),核对稳定就算完成。
  describe('landing on the saved row', () => {
    const frames = (n: number) => act(async () => {
      for (let i = 0; i < n; i += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    function mount() {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const view = { memory: null as ReturnType<typeof useConversationScrollMemory> | null, rowTop: 84, scrollTop: 700, renders: 0 }
      function Harness({ chatId, messageIds, rows }: { chatId: string; messageIds: string[]; rows: string[] }) {
        view.renders += 1
        view.memory = useConversationScrollMemory({ chatId, activationKey: chatId, enabled: true, messageIds, isAtBottomRef: { current: true }, setFollowingTail: vi.fn() })
        return createElement('div', { ref: view.memory.setScrollerRef },
          createElement('div', null, ...rows.map((id) => createElement('div', { key: id, 'data-msg-id': id }))))
      }
      const render = (props: { chatId: string; messageIds: string[]; rows: string[] }) => act(async () => { root.render(createElement(Harness, props)) })
      // 视口顶 100、底 900;行 anchor 的屏幕位置随 scrollTop 走(离开时 scrollTop 700 ⇒ 行上沿 84,即视口顶上方 16px)。
      const geometry = () => {
        const scroller = container.firstElementChild as HTMLElement
        Object.defineProperties(scroller, {
          scrollHeight: { configurable: true, value: 3_000 },
          clientHeight: { configurable: true, value: 800 },
          scrollTop: { configurable: true, get: () => view.scrollTop, set: (value: number) => { view.scrollTop = value } },
        })
        vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 900 } as DOMRect)
        for (const row of Array.from(scroller.querySelectorAll<HTMLElement>('[data-msg-id]'))) {
          vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
            const top = row.dataset.msgId === 'anchor' ? view.rowTop + 700 - view.scrollTop : 2_000
            return { top, bottom: top + 76 } as DOMRect
          })
        }
      }
      const cleanup = async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() }
      return { view, render, geometry, cleanup }
    }
    async function leaveAndReturn(rig: ReturnType<typeof mount>, returnRows: string[]) {
      const ids = ['first', 'anchor', 'last']
      await rig.render({ chatId: 'chat-a', messageIds: ids, rows: ids })
      rig.geometry()
      act(() => publishActiveChatWillChange('chat-a', 'chat-b'))
      await rig.render({ chatId: 'chat-b', messageIds: ['b1'], rows: ['b1'] })
      await rig.render({ chatId: 'chat-a', messageIds: ids, rows: returnRows })
      rig.geometry()
    }

    it('hands the saved row to the list as its landing, then only verifies it and completes', async () => {
      const rig = mount()
      try {
        await leaveAndReturn(rig, ['first', 'anchor', 'last'])
        expect(rig.view.memory!.openLocation()).toEqual({ index: 1, align: 'start', offset: 16 })

        // 列表已把行放在原处 ⇒ 三帧稳定即完成,滚动条一下都不动。
        rig.view.scrollTop = 700
        await frames(5)
        expect(rig.view.scrollTop).toBe(700)
        expect(rig.view.memory!.isPreservingPosition()).toBe(false)
        expect(rig.view.memory!.openLocation(), '恢复完成后同一次激活里的重挂回到最新处').toEqual({ index: 'LAST', align: 'end' })
      } finally { await rig.cleanup() }
    })

    it('corrects a residual offset (content that grew after the list landed)', async () => {
      const rig = mount()
      try {
        await leaveAndReturn(rig, ['first', 'anchor', 'last'])
        rig.view.scrollTop = 690
        await rig.render({ chatId: 'chat-a', messageIds: ['first', 'anchor', 'last'], rows: ['first', 'anchor', 'last'] })
        rig.geometry()
        await frames(6)
        expect(rig.view.scrollTop).toBe(700)
      } finally { await rig.cleanup() }
    })

    it('keeps the same anchor and offset when a block unmounts without a main-chat transition', async () => {
      const ids = ['first', 'anchor', 'last']
      const original = mount()
      await original.render({ chatId: 'chat-a', messageIds: ids, rows: ids })
      original.geometry()
      await original.cleanup()

      const reopened = mount()
      try {
        await reopened.render({ chatId: 'chat-a', messageIds: ids, rows: ids })
        reopened.geometry()
        expect(reopened.view.memory!.openLocation()).toEqual({ index: 1, align: 'start', offset: 16 })
        reopened.view.scrollTop = 690
        await frames(6)
        expect(reopened.view.scrollTop).toBe(700)
        expect(reopened.view.memory!.isPreservingPosition()).toBe(false)
      } finally { await reopened.cleanup() }
    })

    it('captures the real exit after the main selection leaves a still-mounted viewport', async () => {
      const ids = ['first', 'anchor', 'last']
      const original = mount()
      await original.render({ chatId: 'chat-a', messageIds: ids, rows: ids })
      original.geometry()
      act(() => publishActiveChatWillChange('chat-a', 'chat-b'))
      original.view.scrollTop = 720
      await original.cleanup()
      const reopened = mount()
      try {
        await reopened.render({ chatId: 'chat-a', messageIds: ids, rows: ids })
        expect(reopened.view.memory!.openLocation()).toEqual({ index: 1, align: 'start', offset: 36 })
      } finally { await reopened.cleanup() }
    })

    it('does not replay another auth lifetime\'s saved position', async () => {
      const ids = ['first', 'anchor', 'last']
      const original = mount()
      await original.render({ chatId: 'chat-a', messageIds: ids, rows: ids })
      original.geometry()
      await original.cleanup()
      resetAuthSessionBoundary()
      const next = mount()
      try {
        await next.render({ chatId: 'chat-a', messageIds: ids, rows: ids })
        expect(next.view.memory!.openLocation()).toEqual({ index: 'LAST', align: 'end' })
      } finally { await next.cleanup() }
    })

    // 锚点不在窗口里时列表按 openLocation() === null 藏着等(不露出最新处);等不到而放弃时要自己促一次重渲,否则列表一直藏着。
    it('re-renders its caller when it gives up on a saved row that never arrived, so a list hidden while waiting shows again', async () => {
      const rig = mount()
      try {
        await leaveAndReturn(rig, ['first', 'anchor', 'last'])
        vi.useFakeTimers()
        await rig.render({ chatId: 'chat-a', messageIds: ['newer'], rows: ['newer'] })
        expect(rig.view.memory!.openLocation()).toBeNull()
        const before = rig.view.renders
        vi.spyOn(console, 'error').mockImplementation(() => {})
        // 放弃时限按 performance.now() 算,假时钟与它的起点不一定对齐 ⇒ 推足够久,只判「放弃之后有没有重渲」
        await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
        expect(rig.view.renders, '放弃后没有外部重渲也要重算一次').toBeGreaterThan(before)
        expect(rig.view.memory!.openLocation()).toEqual({ index: 'LAST', align: 'end' })
      } finally { vi.useRealTimers(); await rig.cleanup() }
    })

    // #1708 来源消息:要看的那条还没载进窗口 —— 当作要恢复的位置走同一条路(载锚点 → 列表落在它上面 → 核对到稳定)。
    describe('revealMessage', () => {
      function mountWithAnchor(loadMessageAnchor: (id: string) => Promise<void>) {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        const view = { memory: null as ReturnType<typeof useConversationScrollMemory> | null, renders: 0, scrollTop: 0 }
        const setFollowingTail = vi.fn()
        function Harness({ messageIds }: { messageIds: string[] }) {
          view.renders += 1
          view.memory = useConversationScrollMemory({ chatId: 'chat-a', activationKey: 'chat-a', enabled: true, messageIds, isAtBottomRef: { current: true }, setFollowingTail, loadMessageAnchor })
          return createElement('div', { ref: view.memory.setScrollerRef },
            createElement('div', null, ...messageIds.map((id) => createElement('div', { key: id, 'data-msg-id': id }))))
        }
        const render = (messageIds: string[]) => act(async () => { root.render(createElement(Harness, { messageIds })) })
        // 视口顶 100、高 800;要看的那一行 m1 的上沿随 scrollTop 走,落位点是视口 35% 处(offset 280)。
        const geometry = () => {
          const scroller = container.firstElementChild as HTMLElement
          Object.defineProperties(scroller, {
            scrollHeight: { configurable: true, value: 3_000 },
            clientHeight: { configurable: true, value: 800 },
            scrollTop: { configurable: true, get: () => view.scrollTop, set: (value: number) => { view.scrollTop = value } },
          })
          vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 900 } as DOMRect)
          for (const rowEl of Array.from(scroller.querySelectorAll<HTMLElement>('[data-msg-id]'))) {
            vi.spyOn(rowEl, 'getBoundingClientRect').mockImplementation(() => {
              const top = rowEl.dataset.msgId === 'm1' ? 100 + 280 + 500 - view.scrollTop : 2_000
              return { top, bottom: top + 60 } as DOMRect
            })
          }
        }
        const cleanup = async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() }
        return { view, render, geometry, cleanup, setFollowingTail }
      }

      it('loads the window around it, lands the remounted list on it, and resolves once it has settled', async () => {
        const load = vi.fn(() => Promise.resolve())
        const rig = mountWithAnchor(load)
        try {
          await rig.render(['m40', 'm41'])
          rig.geometry()
          let settled = false
          let revealed: Promise<void> = Promise.resolve()
          await act(async () => { revealed = rig.view.memory!.revealMessage('m1').then(() => { settled = true }) })
          expect(load).toHaveBeenCalledWith('m1')
          expect(rig.view.memory!.openLocation(), 'the list waits hidden for the anchor instead of showing the latest').toBeNull()
          expect(rig.setFollowingTail).toHaveBeenCalledWith(false)
          await rig.render(['m0', 'm1', 'm2']) // the window around the anchor arrives
          rig.geometry()
          expect(rig.view.memory!.openLocation()).toEqual({ index: 1, align: 'start', offset: -280 })
          rig.view.scrollTop = 0 // the remounted list is not where it should be yet: the settle loop moves it there
          await frames(8)
          await act(async () => { await revealed })
          expect(settled).toBe(true)
          expect(rig.view.scrollTop).toBe(500)
        } finally { await rig.cleanup() }
      })

      it('rejects when the message cannot be loaded, and re-renders so the list hidden while waiting shows again', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const rig = mountWithAnchor(() => Promise.reject(new Error('Saved conversation message is no longer available')))
        try {
          await rig.render(['m40', 'm41'])
          rig.geometry()
          let error: Error | null = null
          let revealed: Promise<void> = Promise.resolve()
          await act(async () => { revealed = rig.view.memory!.revealMessage('m1').catch((e: Error) => { error = e }) })
          await act(async () => { await revealed })
          expect(error).not.toBeNull()
          expect(rig.view.memory!.openLocation(), 'back at the latest, not hidden').toEqual({ index: 'LAST', align: 'end' })
        } finally { await rig.cleanup() }
      })
    })

    it('opens at the latest message when the reader left at the bottom, and reports null while the saved row is outside the window', async () => {
      const rig = mount()
      try {
        const ids = ['first', 'anchor', 'last']
        await rig.render({ chatId: 'chat-a', messageIds: ids, rows: ids })
        rig.geometry()
        rig.view.scrollTop = 2_200
        act(() => publishActiveChatWillChange('chat-a', 'chat-b'))
        await rig.render({ chatId: 'chat-b', messageIds: ['b1'], rows: ['b1'] })
        await rig.render({ chatId: 'chat-a', messageIds: ids, rows: ids })
        expect(rig.view.memory!.openLocation()).toEqual({ index: 'LAST', align: 'end' })

        rig.view.scrollTop = 700
        await leaveAndReturn(rig, ['first', 'anchor', 'last'])
        await rig.render({ chatId: 'chat-a', messageIds: ['newer'], rows: ['newer'] })
        expect(rig.view.memory!.openLocation()).toBeNull()
      } finally { await rig.cleanup() }
    })
  })
})
