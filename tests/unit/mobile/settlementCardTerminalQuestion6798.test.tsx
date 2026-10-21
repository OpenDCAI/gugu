// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settlement, SettlementQuestion, SettlementResponse } from '@gugu/session-core/session-record/contract'
import { SettlementCard } from '../../../apps/desktop/src/mobile/agent-watch/TimelineView'
import { createReactHarness } from '../../support/testHarness'

// #6798 #7035:宿主能从手机代答的终端提问(结算带 `questions`),手机上整份题目按一套表单画;
// 不带题目的终端提问仍说「去终端答」(阴性对照在 settlementCardAnswerGap.test.tsx)。

const q = (question: string, labels: string[], multiSelect = false): SettlementQuestion => ({
  question,
  multiSelect,
  options: labels.map((label) => ({ optionId: label, name: label })),
})

function asked(questions: SettlementQuestion[], patch: Partial<Settlement> = {}): Settlement {
  return {
    itemId: 'ask-1',
    kind: 'question',
    title: questions[0].question,
    options: questions[0].options,
    questions,
    state: 'pending',
    optionId: null,
    resolvedBy: null,
    resolvedAt: null,
    ...patch,
  }
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

async function render(settlement: Settlement) {
  const onRespond = vi.fn<(input: SettlementResponse) => void>()
  await harness.render(<SettlementCard settlement={settlement} runtime="pty" busy={false} onRespond={onRespond} />)
  const $ = (selector: string) => harness.container.querySelector<HTMLElement>(selector)
  const click = (el: HTMLElement | null) => act(async () => { el!.click() })
  return { onRespond, $, click, all: (selector: string) => [...harness.container.querySelectorAll<HTMLElement>(selector)] }
}

describe('SettlementCard — 终端提问从手机答', () => {
  it('一道单选:选一项才能交,交上去的是 label 原文', async () => {
    const card = await render(asked([q('去哪?', ['北京', '上海'])]))
    expect(card.$('[data-testid="agent-watch-settlement-answer-elsewhere"]')).toBeNull()
    // 只有表单这一套选项:❌ 再叠一排第一题的老按钮(点下去走 optionId,终端腿上必被拒)。
    expect(card.all('[data-option-id]').map((el) => el.dataset.optionId)).toEqual(['北京', '上海'])
    const submit = card.$('[data-testid="agent-watch-settlement-submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await card.click(card.$('[data-option-id="上海"]'))
    expect(card.$('[data-option-id="上海"]')!.getAttribute('aria-checked')).toBe('true')
    await card.click(submit)
    expect(card.onRespond).toHaveBeenCalledWith({ itemId: 'ask-1', kind: 'question', answers: [{ selected: ['上海'] }] })
  })

  it('自己写:切过去选项就不算,写的原样交(多行也行);空的交不了', async () => {
    const card = await render(asked([q('去哪?', ['北京', '上海'])]))
    await card.click(card.$('[data-option-id="北京"]'))
    await card.click(card.$('[data-testid="agent-watch-settlement-write-own"]'))
    expect(card.$('[data-option-id="北京"]')!.getAttribute('aria-checked')).toBe('false')
    const submit = card.$('[data-testid="agent-watch-settlement-submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    const textarea = card.$('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '都不去\n在家 😀')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await card.click(submit)
    expect(card.onRespond).toHaveBeenCalledWith({ itemId: 'ask-1', kind: 'question', answers: [{ selected: [], other: '都不去\n在家 😀' }] })
  })

  it('多题 + 多选:多选可以一个不勾;每题一份答案按题序', async () => {
    const card = await render(asked([q('一?', ['a', 'b']), q('二?', ['c', 'd'], true)]))
    await card.click(card.$('[data-option-id="b"]'))
    await card.click(card.$('[data-option-id="c"]'))
    await card.click(card.$('[data-option-id="d"]'))
    await card.click(card.$('[data-option-id="c"]'))
    await card.click(card.$('[data-testid="agent-watch-settlement-submit"]'))
    expect(card.onRespond).toHaveBeenCalledWith({
      itemId: 'ask-1',
      kind: 'question',
      answers: [{ selected: ['b'] }, { selected: ['d'] }],
    })
  })

  it('#7035 多选也能自己写:勾上「自己写」不清掉已勾的选项,写的一段跟着交', async () => {
    const card = await render(asked([q('带谁?', ['猫', '狗'], true)]))
    const writeOwn = card.$('[data-testid="agent-watch-settlement-write-own"]')!
    expect(writeOwn.getAttribute('role')).toBe('checkbox')
    await card.click(card.$('[data-option-id="猫"]'))
    await card.click(writeOwn)
    expect(card.$('[data-option-id="猫"]')!.getAttribute('aria-checked')).toBe('true')
    const textarea = card.$('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '还有仓鼠')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await card.click(card.$('[data-option-id="狗"]'))
    await card.click(card.$('[data-testid="agent-watch-settlement-submit"]'))
    expect(card.onRespond).toHaveBeenCalledWith({
      itemId: 'ask-1',
      kind: 'question',
      answers: [{ selected: ['猫', '狗'], other: '还有仓鼠' }],
    })
  })

  it('不回答 = decline', async () => {
    const card = await render(asked([q('去哪?', ['北京'])]))
    await card.click(card.$('[data-testid="agent-watch-settlement-decline"]'))
    expect(card.onRespond).toHaveBeenCalledWith({ itemId: 'ask-1', kind: 'question', decline: true })
  })

  it('手机端答了:沿用「已在手机端回答」;没有表单,标题不再说「在等你回答」', async () => {
    const card = await render(asked([q('一?', ['a']), q('二?', ['c'], true)], {
      state: 'resolved', resolvedBy: 'mobile', resolvedAt: 1,
    }))
    expect(card.$('[data-testid="agent-watch-settlement-answered"]')!.textContent).toBe('已在手机端回答')
    expect(card.$('.gg-aw-card-title')!.textContent).toContain('2 个问题')
    expect(card.$('[data-testid="agent-watch-settlement-submit"]')).toBeNull()
  })

  it('在终端里答了、拒了(记录里有了结果、没人认领):与别的腿同一句「这条已经不需要回答了」', async () => {
    const card = await render(asked([q('去哪?', ['北京'])], { state: 'cancelled', resultRecorded: true, resolvedAt: 1 }))
    expect(harness.container.textContent).toContain('这条已经不需要回答了')
    expect(card.$('[data-testid="agent-watch-settlement-submit"]')).toBeNull()
  })
})
