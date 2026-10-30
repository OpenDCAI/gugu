/** @jsxImportSource solid-js */
/**
 * #7333 母版补页 05:转录里八处可读文字落到字阶 —— 标注 12/18(复制小字、文件说明、日期、界线标签与句内操作)、
 * 紧凑界面 14/20(文件名、模式钮),真 Chromium。
 *
 * 这些行的 measure() 都是常量、行根写死同一个高度,「measure === offsetHeight」判不出字长出了行:字会被静静裁掉,
 * 行高照样吻合。所以这里读的是行**里面**:每一格的计算字号与行高,以及它的矩形落在行(卡、页脚、按钮)里。
 * 选择器落空时那一格的键缺席,读成 undefined(响亮的失败),❌ 一个看着干净的 0。
 */
import { describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { compactionUnitDef } from '@session-chat/components/rows/boundary/compaction.def'
import { contextResetUnitDef } from '@session-chat/components/rows/boundary/context-reset.def'
import { sessionConditionUnitDef } from '@session-chat/components/rows/boundary/session-condition.def'
import { sessionNoticeUnitDef } from '@session-chat/components/rows/boundary/session-notice.def'
import { daySeparatorUnitDef } from '@session-chat/components/rows/day-separator/day-separator.def'
import { OPENED_OUTPUT_ROW_H, openedOutputUnitDef } from '@session-chat/components/rows/opened-output/opened-output.def'
import { createChatContext } from '@session-chat/chat-context'
import { createChatView } from '@session-chat/chat-view'
import type { ChatCommands } from '@session-chat/commands'
import type { ChatMessage, OpenedOutputItem, TranscriptTurn } from '@session-chat/model'
import { createChatState } from '@session-chat/state/chat-state'
import { until, untilStable } from '../../../../tests/support/awaitCondition'
import { makeContractCtx, renderAndMeasureUnit, type ContractInspector } from './contract'

const CAPTION = { size: 12, leading: 18 } as const
const COMPACT = { size: 14, leading: 20 } as const
const px = (value: string) => Number.parseFloat(value) || 0

/** One slot's type and how far its box pokes out of `box` (positive = out), keyed `${slot}:…`. */
function readSlot(read: Record<string, number>, slot: string, element: Element | null, box: DOMRect) {
  if (!element) return
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  read[`${slot}:size`] = px(style.fontSize)
  read[`${slot}:leading`] = Math.round(px(style.lineHeight))
  read[`${slot}:height`] = rect.height
  read[`${slot}:out`] = Math.max(box.top - rect.top, rect.bottom - box.bottom, box.left - rect.left, rect.right - box.right)
}

const expectTier = (read: Record<string, number>, slot: string, tier: { size: number; leading: number }) => {
  expect(read[`${slot}:size`], `${slot} font-size`).toBe(tier.size)
  expect(read[`${slot}:leading`], `${slot} line-height`).toBe(tier.leading)
  expect(read[`${slot}:out`], `${slot} pokes out of its row`).toBeLessThanOrEqual(0.5)
}

const at = new Date(2024, 2, 3, 9, 41).getTime()
const boundaryRows = [
  {
    label: 'day separator (the widest, absolute date)',
    def: daySeparatorUnitDef,
    data: { kind: 'day-separator', id: 'small-day', startedAt: at },
    row: 'day-separator',
    slots: ['day-separator-label'],
  },
  {
    label: 'compaction, completed (its longest sentence)',
    def: compactionUnitDef,
    data: { kind: 'compaction', id: 'small-cmp', seq: 0, compactionId: 'cmp_001', status: 'completed', summary: '## 保留\n改 schema。', startedAt: at },
    row: 'compaction',
    slots: ['compaction-label'],
  },
  {
    label: 'context reset',
    def: contextResetUnitDef,
    data: { kind: 'context-reset', id: 'small-reset', seq: 0, reason: 'Session not found: sess_abc', at },
    row: 'context-reset',
    slots: ['context-reset-label'],
  },
  {
    label: 'session condition with its in-sentence action',
    def: sessionConditionUnitDef,
    data: {
      kind: 'session-condition',
      id: 'small-condition',
      code: 'provider-session-missing',
      hasVisibleHistory: true,
      detail: 'Session not found: sess_abc',
      actions: [{ label: '重新打开', run: () => undefined }],
    },
    row: 'session-condition',
    slots: ['session-condition-label', 'session-condition-action'],
  },
] as const

describe('the transcript\'s small text in the master\'s tiers (#7333 母版补页 05)', () => {
  // 420 is where the 12px sentences first outgrew the row (compaction 415, context reset 427 wide); 320 is a narrow pane.
  it.each(boundaryRows.flatMap((row) => [420, 320].map((width) => ({ ...row, width }))))(
    '$label at $width: label (and action) 12/18, inside the 24px row; a cut sentence is whole in the title',
    async ({ def, data, row, slots, width }) => {
      const reading = await renderAndMeasureUnit(def as never, data as never, makeContractCtx({ width }), ((host) => {
        const root = host.querySelector<HTMLElement>(`[data-slot="${row}"]`)
        const read: Record<string, number> = { rowCount: root ? 1 : 0 }
        if (!root) return read
        const box = root.getBoundingClientRect()
        read.rowHeight = box.height
        for (const slot of slots) {
          const element = root.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
          readSlot(read, slot, element, box)
          if (element) read[`${slot}:cut`] = element.scrollWidth > element.clientWidth + 0.5 ? 1 : 0
        }
        const sentence = root.getAttribute('aria-label') ?? ''
        read.titleLeadsWithSentence = sentence !== '' && (root.title === sentence || root.title.startsWith(`${sentence}\n`)) ? 1 : 0
        return read
      }) satisfies ContractInspector)
      const read = reading.inspected
      expect(read.rowCount, 'the row is not in the DOM').toBe(1)
      expect(reading.dom).toBe(reading.computed)
      expect(read.rowHeight, 'the row is no longer 24 high').toBe(24)
      for (const slot of slots) expectTier(read, slot, CAPTION)
      if (slots.includes('session-condition-action' as never)) {
        expect(read['session-condition-action:cut'], 'the in-sentence action was cut').toBe(0)
      }
      if (slots.some((slot) => read[`${slot}:cut`] === 1)) {
        expect(read.titleLeadsWithSentence, 'the label was cut and its whole sentence is not in the title').toBe(1)
      }
      expect(reading.spill).toBeLessThanOrEqual(0.5)
    },
  )

  it('at 320 the fixed sentences really are cut — the title check above is exercised, not passed by default', async () => {
    const reading = await renderAndMeasureUnit(contextResetUnitDef, boundaryRows[2].data as never, makeContractCtx({ width: 320 }), (host) => {
      const label = host.querySelector<HTMLElement>('[data-slot="context-reset-label"]')
      return { cut: label && label.scrollWidth > label.clientWidth + 0.5 ? 1 : 0 }
    })
    expect(reading.inspected.cut).toBe(1)
  })

  it('the session condition\'s action stays part of the sentence: on the label\'s line, same tier, no row of its own', async () => {
    const reading = await renderAndMeasureUnit(sessionConditionUnitDef, boundaryRows[3].data as never, makeContractCtx({ width: 420 }), (host): Record<string, number> => {
      const label = host.querySelector<HTMLElement>('[data-slot="session-condition-label"]')
      const action = host.querySelector<HTMLElement>('[data-slot="session-condition-action"]')
      if (!label || !action) return { found: 0 }
      const a = label.getBoundingClientRect()
      const b = action.getBoundingClientRect()
      return { found: 1, centreGap: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)), after: b.left - a.right }
    })
    expect(reading.inspected.found).toBe(1)
    expect(reading.inspected.centreGap, 'the action is not on the label\'s line').toBeLessThanOrEqual(1)
    expect(reading.inspected.after, 'the action does not follow the label').toBeGreaterThanOrEqual(0)
  })

  it('a provider notice too long for the row is cut with an ellipsis at 12/18, the whole sentence kept in the title', async () => {
    const title = '供应商提示:这一段话很长很长,'.repeat(6)
    const reading = await renderAndMeasureUnit(
      sessionNoticeUnitDef,
      { kind: 'session-notice', id: 'small-notice', seq: 0, code: 'provider-notice', detail: title, title, at } as never,
      makeContractCtx({ width: 320 }),
      (host) => {
        const root = host.querySelector<HTMLElement>('[data-slot="session-notice"]')
        const label = host.querySelector<HTMLElement>('[data-slot="session-notice-label"]')
        const read: Record<string, number> = { found: root && label ? 1 : 0 }
        if (!root || !label) return read
        readSlot(read, 'session-notice-label', label, root.getBoundingClientRect())
        read.cut = label.scrollWidth > label.clientWidth ? 1 : 0
        read.ellipsis = getComputedStyle(label).textOverflow === 'ellipsis' ? 1 : 0
        read.titleKept = root.title === title ? 1 : 0
        return read
      },
    )
    expect(reading.inspected.found).toBe(1)
    expectTier(reading.inspected, 'session-notice-label', CAPTION)
    expect(reading.inspected.cut, 'the sentence fit — this does not test the cut').toBe(1)
    expect(reading.inspected.ellipsis).toBe(1)
    expect(reading.inspected.titleKept).toBe(1)
    expect(reading.spill).toBeLessThanOrEqual(0.5)
  })
})

const documentCard: OpenedOutputItem = {
  kind: 'opened-output',
  id: 't1:output:file:/r/汇报-10-15.html',
  turnId: 't1',
  output: { kind: 'file', path: '/Users/me/reports/汇报-10-15.html' },
  index: 0,
  count: 1,
}
const longCard: OpenedOutputItem = { ...documentCard, output: { kind: 'file', path: `/r/${'很长的汇报名字'.repeat(8)}结尾.html` } }
const withMenu: ChatCommands = { onOpenOutput: () => undefined, outputOpenMode: () => '侧边栏', onOutputMenu: () => undefined }

/** The card's cells: name / detail / mode button type and box; the mode button's icon inside it; its focus ring inside the row slot. */
const cardCells: ContractInspector = (host) => {
  const card = host.querySelector<HTMLElement>('[data-slot="opened-output"]')
  const read: Record<string, number> = { cardCount: card ? 1 : 0 }
  if (!card) return read
  const box = card.getBoundingClientRect()
  read.cardHeight = box.height
  readSlot(read, 'name', card.querySelector('[data-slot="opened-output-name"]'), box)
  readSlot(read, 'detail', card.querySelector('[data-slot="opened-output-detail"]'), box)
  const mode = card.querySelector<HTMLElement>('[data-slot="opened-output-mode"]')
  readSlot(read, 'mode', mode, box)
  if (mode) {
    const button = mode.getBoundingClientRect()
    const icon = mode.querySelector('svg')
    if (icon) {
      const r = icon.getBoundingClientRect()
      read.iconOut = Math.max(button.top - r.top, r.bottom - button.bottom, button.left - r.left, r.right - button.right)
    }
    const label = [...mode.children].find((child) => child.tagName === 'SPAN') as HTMLElement | undefined
    read.labelShown = label && label.offsetWidth > 0 ? 1 : 0
    // Its keyboard ring: 2px outline 1px out. The whole ring must stay inside what draws the row (the slot).
    const slot = card.parentElement!.getBoundingClientRect()
    const ring = 3
    read.ringOut = Math.max(slot.top - (button.top - ring), button.bottom + ring - slot.bottom, button.right + ring - slot.right)
  }
  return read
}

describe('the opened-output card\'s text in the master\'s tiers (#7333 母版补页 05)', () => {
  it('name 14/20 and detail 12/18 stand inside the allocated row; the mode button is 14/20 inside its 28px', async () => {
    const reading = await renderAndMeasureUnit(openedOutputUnitDef, documentCard, makeContractCtx({ width: 420 }), cardCells, withMenu)
    const read = reading.inspected
    expect(read.cardCount).toBe(1)
    expect(read.cardHeight).toBe(OPENED_OUTPUT_ROW_H)
    expectTier(read, 'name', COMPACT)
    expectTier(read, 'detail', CAPTION)
    expectTier(read, 'mode', COMPACT)
    expect(read['mode:height'], 'the mode button is no longer 28 high').toBe(28)
    expect(read['name:height'] + read['detail:height'], 'the two lines no longer fit the row').toBeLessThanOrEqual(OPENED_OUTPUT_ROW_H)
    expect(read.labelShown, 'the mode label is hidden at a wide card').toBe(1)
    expect(read.iconOut, 'the mode button\'s icon pokes out of it').toBeLessThanOrEqual(0.5)
    expect(read.ringOut, 'the mode button\'s focus ring would be cut by the row').toBeLessThanOrEqual(0.5)
  })

  it('narrower than 260: the mode label folds away, the icon and the ring stay whole, the name keeps its extension', async () => {
    const reading = await renderAndMeasureUnit(openedOutputUnitDef, longCard, makeContractCtx({ width: 240 }), cardCells, withMenu)
    const read = reading.inspected
    expect(read.labelShown, 'the mode label still shows under 260').toBe(0)
    expectTier(read, 'name', COMPACT)
    expectTier(read, 'detail', CAPTION)
    expectTier(read, 'mode', COMPACT)
    expect(read.iconOut).toBeLessThanOrEqual(0.5)
    expect(read.ringOut).toBeLessThanOrEqual(0.5)
    expect(reading.spill).toBeLessThanOrEqual(0.5)
  })
})

describe('the reply\'s copy button in the caption tier (#7333 母版补页 05)', () => {
  it('copy reads 12/18 inside the 24px footer, does not push the reply\'s end, and shows for the keyboard', async () => {
    const msg = (id: string, seq: number, role: ChatMessage['role'], text: string): ChatMessage => ({ kind: 'message', id, seq, role, text })
    const turn: TranscriptTurn = {
      id: 't1',
      seq: 1,
      initiator: 'user',
      startedAt: Date.now() - 5_000,
      items: [msg('u1', 0, 'user', '问'), msg('a1', 1, 'assistant', '答一句话。')] as TranscriptTurn['items'],
      outcome: { kind: 'done' },
    }
    const ctx = createChatContext()
    const state = createChatState(ctx)
    state.session.setGenerating(false)
    state.transcript.history.seed([turn])
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;'
    document.body.appendChild(host)
    const view = createChatView({ context: ctx, state, parent: host })
    try {
      const replyCopy = () => host.querySelector<HTMLButtonElement>('[data-chat-canvas] [data-item-id="a1"] button[aria-label="Copy"]')
      await until('the reply\'s copy button mounts', () => replyCopy() !== null)
      const button = replyCopy()!
      // User messages now have their own copy action too. Keep this typography/geometry
      // reading on the assistant reply even when the user's identically named button comes first.
      const userCopy = host.querySelector('[data-user-message-actions] button[aria-label="Copy"]')
      expect(userCopy, 'the competing user copy action must be present').not.toBeNull()
      expect(button).not.toBe(userCopy)
      const footer = button.parentElement!
      const reply = footer.parentElement!
      const label = button.querySelector('span')!
      expect(label, 'the assistant copy label did not mount').not.toBeNull()
      const style = getComputedStyle(label)
      expect({ size: px(style.fontSize), leading: Math.round(px(style.lineHeight)) }).toEqual(CAPTION)
      const f = footer.getBoundingClientRect()
      const b = button.getBoundingClientRect()
      expect(Math.round(f.height), 'the footer is no longer 24 high').toBe(24)
      expect(Math.max(f.top - b.top, b.bottom - f.bottom), 'the copy button pokes out of the footer').toBeLessThanOrEqual(0.5)
      expect(f.bottom - reply.getBoundingClientRect().bottom, 'the footer reaches past the reply\'s end').toBeLessThanOrEqual(0.5)
      // Hidden until hovered, but the keyboard reveals it: Tab onto it from a button placed just before.
      const start = Object.assign(document.createElement('button'), { textContent: 'start' })
      button.before(start)
      start.focus()
      await userEvent.tab()
      start.remove()
      expect(document.activeElement).toBe(button)
      await untilStable('the copy button settles', () => getComputedStyle(button).opacity)
      expect(getComputedStyle(button).opacity, 'a keyboard-focused copy button stayed hidden').toBe('1')
    } finally {
      view.dispose()
      ctx.dispose()
      state.dispose()
      document.body.removeChild(host)
    }
  })
})
