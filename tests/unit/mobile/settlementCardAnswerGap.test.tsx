// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Settlement, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { SettlementCard } from '../../../apps/desktop/src/mobile/agent-watch/TimelineView'
import { createReactHarness } from '../../support/testHarness'

// #6739:手机答不了的那几格(终端腿的一切、ACP 腿的提问),卡片一开始就说去哪答,❌ 摆一排按下去必被拒的按钮。
// 判据与宿主写侧同一条(`remoteSettlementGap`),所以这里只钉「卡片照它画」。

function pending(kind: 'permission' | 'question'): Settlement {
  return {
    itemId: 'item-1',
    kind,
    title: '10月3日从海拉尔飞到哪个城市?',
    detail: '目的地',
    options: [{ optionId: 'a', name: '北京' }, { optionId: 'b', name: '上海' }],
    state: 'pending',
    optionId: null,
    resolvedBy: null,
    resolvedAt: null,
  }
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

async function render(settlement: Settlement, runtime: SessionpageSessionSummary['runtime']) {
  await harness.render(<SettlementCard settlement={settlement} runtime={runtime} busy={false} onRespond={() => undefined} />)
  return {
    elsewhere: harness.container.querySelector('[data-testid="agent-watch-settlement-answer-elsewhere"]'),
    buttons: harness.container.querySelectorAll('[data-option-id]').length,
  }
}

describe('SettlementCard — 手机答不了的格子一开始就说去哪答', () => {
  it('终端腿的提问(设计同事 撞见的那格):说去终端里答,没有按钮', async () => {
    const card = await render(pending('question'), 'pty')
    expect(card.elsewhere).not.toBeNull()
    expect(card.buttons).toBe(0)
  })

  it('终端腿的审批、ACP 腿的提问、腿不明:同样没有按钮', async () => {
    for (const [kind, runtime] of [['permission', 'pty'], ['question', 'acp'], ['permission', 'unknown']] as const) {
      const card = await render(pending(kind), runtime)
      expect(card.elsewhere, `${kind}/${runtime}`).not.toBeNull()
      expect(card.buttons, `${kind}/${runtime}`).toBe(0)
    }
  })

  it('反向控:ACP 腿的审批照常画按钮,不说去别处答', async () => {
    const card = await render(pending('permission'), 'acp')
    expect(card.elsewhere).toBeNull()
    expect(card.buttons).toBe(2)
  })

  it('已了结的卡不受影响:终端腿上别处答完,照常显示回执', async () => {
    await render({ ...pending('question'), state: 'resolved', optionId: 'a', resolvedBy: 'desktop', resolvedAt: 1 }, 'pty')
    expect(harness.container.querySelector('[data-testid="agent-watch-settlement-answer-elsewhere"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="agent-watch-settlement-answered"]')).not.toBeNull()
  })
})
