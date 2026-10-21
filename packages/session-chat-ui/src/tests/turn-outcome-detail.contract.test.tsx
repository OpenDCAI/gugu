/** @jsxImportSource solid-js */
/**
 * 失败回合的**原文详情**契约(#5858)。
 *
 * # 这条判据读的是什么
 *
 * 票的原话是「笼统文案只作摘要,不作全部」。修之前,provider 的原文**确实已经**被带到了
 * `outcome.detail` —— 但它只住在徽章的 `title` 与 `aria-label` 里。真机读数(mac1,
 * 2026-09-20,codex + Work + 咕咕网关模型):引擎被杀那一格屏幕上是
 * 「Turn failed · the prompt could not be delivered」,适配器拒收一条超长指令那一格**逐字相同**,
 * 而两者的 `title` 分别是「ACP connection closed」与「Input exceeds the maximum length…」。
 * ⇒ 缺的不是数据,是**它上不上得了屏幕**。
 *
 * 所以这里读的不是「detail 在不在 DOM 里」——`title` 属性也在 DOM 里,那样判据会恒绿。
 * 读的是**渲染出来的文本**(`textContent`):
 *   ① 收起时:原文**不在**渲染文本里(它是摘要那一行,不该把原文摊在脸上);
 *   ② 展开时:原文**逐字**出现在渲染文本里(含换行),且 `measure()` 与真实 DOM 高度**相等**
 *      —— 这一族是离屏测量 + 虚拟化,量不准的行会重叠/跳动。
 *
 * # 变异对照(没有它,上面每一条绿都不算数)
 *
 * 最后一个 describe 挂着一条**修之前那个形状**的收尾行:detail 只进 `title`,永远不展开。
 * 它必须在「展开后原文出现在渲染文本里」那一项上**红**,而在其余项上保持绿 ——
 * 否则这条判据动的就不止一个变量,证不了它判的是那个变量。
 */

import { ROW_H } from '@session-chat/components/engine/row-metrics'
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def'
import { outcomeRow } from '@session-chat/components/rows/turn-outcome/turn-outcome.css'
import { defineUnit } from '@session-chat/core/units'
import type { TurnOutcomeItem } from '@session-chat/model'
import { turnOutcomeDetailId } from '@session-chat/state/flatten'
import { describe, expect, it } from 'vitest'
import { makeContractCtx, renderAndMeasureUnit } from './contract'

const WIDTH = 640
const TURN_ID = 'turn-detail'

/** 适配器拒收那一格的**真实** detail 形状:一句人话 + 它自己带着的结构化负载。 */
const VERBATIM =
  'Input exceeds the maximum length of 1048576 characters.\n'
  + 'input_error_code=input_too_large, max_chars=1048576, actual_chars=1400034'

const failedWithDetail: TurnOutcomeItem = {
  kind: 'turn-outcome',
  turnId: TURN_ID,
  id: `${TURN_ID}:outcome`,
  outcome: { kind: 'error', reason: 'prompt_failed', detail: VERBATIM },
  prompt: '把这段东西读一遍',
}

const processClosed: TurnOutcomeItem = {
  kind: 'turn-outcome',
  turnId: TURN_ID,
  id: `${TURN_ID}:outcome`,
  outcome: { kind: 'error', reason: 'process_closed', detail: 'exit code=1\nsome adapter stderr' },
  prompt: '把这段东西读一遍',
}

const openDetail = () =>
  makeContractCtx({ width: WIDTH, isCollapsed: (id) => id === turnOutcomeDetailId(TURN_ID) })

/** 渲染出来的**文本**,不含属性 —— `title`/`aria-label` 进不来,那正是这条判据的要害。 */
function renderedText(host: HTMLElement): string {
  return host.textContent ?? ''
}

async function read(def: typeof turnOutcomeUnitDef, item: TurnOutcomeItem, expanded: boolean) {
  let text = ''
  let bandChars = 0
  const reading = await renderAndMeasureUnit(
    def,
    item,
    expanded ? openDetail() : makeContractCtx({ width: WIDTH }),
    (host) => {
      text = renderedText(host)
      const band = host.querySelector('[data-slot="turn-outcome-detail"]')
      bandChars = band?.textContent?.length ?? 0
      return { bandChars }
    },
    { onRestorePrompt: () => {} }
  )
  return { ...reading, text, bandChars }
}

describe('失败回合的原文详情上得了屏幕(#5858)', () => {
  it('收起时:屏幕上只有摘要,原文不在渲染文本里', async () => {
    const r = await read(turnOutcomeUnitDef, failedWithDetail, false)
    // 阳控:摘要那一截确实画出来了 —— 否则下面那句「原文不在」可能只是什么都没画。
    expect(r.text.length, '这一行一个字都没画,下面的否定读数是空的').toBeGreaterThan(0)
    expect(r.text).not.toContain('input_error_code=input_too_large')
    expect(r.computed).toBe(ROW_H)
    expect(r.dom).toBe(r.computed)
  })

  it('展开时:原文逐字出现在渲染文本里,而且高度量得准', async () => {
    const r = await read(turnOutcomeUnitDef, failedWithDetail, true)
    expect(r.text).toContain('Input exceeds the maximum length of 1048576 characters.')
    expect(r.text).toContain('input_error_code=input_too_large, max_chars=1048576, actual_chars=1400034')
    // 逐字 = 连换行一起:两段之间不是被拼成一行,也不是被截断。
    expect(r.bandChars).toBe(VERBATIM.length)
    expect(r.computed).toBeGreaterThan(ROW_H)
    expect(r.dom, `measure()=${r.computed} 与真实 DOM=${r.dom} 不符 —— 虚拟化会让这一行重叠`).toBe(
      r.computed
    )
  })

  it('没有 detail 的失败行不长出一颗骗人的「详情」', async () => {
    const bare: TurnOutcomeItem = {
      kind: 'turn-outcome',
      turnId: TURN_ID,
      id: `${TURN_ID}:outcome`,
      outcome: { kind: 'error', reason: 'prompt_failed' },
    }
    let toggles = 0
    const reading = await renderAndMeasureUnit(
      turnOutcomeUnitDef,
      bare,
      openDetail(),
      (host) => {
        toggles = host.querySelectorAll('[data-slot="turn-outcome-badge"][data-detail-toggle]').length
        return { toggles }
      }
    )
    expect(toggles, '没有原文却把徽章做成了开关 —— 点开是个空框,那是在骗人').toBe(0)
    // 开关开着也不许长高 —— 「有详情可看」这个承诺必须与真的有没有详情一致。
    expect(reading.computed).toBe(ROW_H)
    expect(reading.dom).toBe(reading.computed)
  })

  /**
   * ⭐ **这条判据是被我自己的两次失败逼出来的,留着它。**
   *
   * 「详情」开关先后被做成 ① lane 上一颗独立按钮、② 徽章里多一截字。两次都在 480px 下
   * 把 `outcomeRuleTrail`(#3568 的**失败作用域记号**,`flex: 1 1 0`,只吃剩余空间)挤成
   * **0×1** —— 而这件事在 640px 上看不出来,只有窄档才露头。
   * ⇒ 判据直接读那条线的宽高比:它必须仍然是**跨度**。
   *   谁哪天想在这条 lane 上再加一个控件,会先在这里红。
   */
  it('开关一分宽度都不许从失败作用域那条记号线上拿(窄档 480px)', async () => {
    let ratio = -1
    let ruleW = -1
    await renderAndMeasureUnit(
      turnOutcomeUnitDef,
      failedWithDetail,
      makeContractCtx({ width: 480 }),
      (host) => {
        const rule = host.querySelector('[data-slot="turn-outcome-rule"]')
        if (!rule) throw new Error('那条作用域记号线不在 DOM 里 —— 这次读数是空的,不是阴性')
        const r = rule.getBoundingClientRect()
        ruleW = Math.round(r.width * 100) / 100
        ratio = r.height > 0 ? r.width / r.height : 0
        return { ruleW, ratio }
      },
      { onRestorePrompt: () => {} }
    )
    expect(
      ratio,
      `那条线量出来 ${ruleW}px 宽(宽高比 ${ratio.toFixed(1)})—— 开关把它的剩余空间吃掉了,`
        + ' #3568 要的「跨度」变成了一个点'
    ).toBeGreaterThanOrEqual(8)
  })

  it('进程死亡与 prompt 被拒在屏幕上不是同一句话(#4875 ②)', async () => {
    const a = await read(turnOutcomeUnitDef, failedWithDetail, false)
    const b = await read(turnOutcomeUnitDef, processClosed, false)
    // 两边都画了字(阳控),而且说的不是同一句 —— 这正是那张票的缺陷。
    expect(a.text.length).toBeGreaterThan(0)
    expect(b.text.length).toBeGreaterThan(0)
    expect(b.text).not.toBe(a.text)
  })
})

// #7103 上游自己说了的(网关回给 codex 的那一句):收起时那一行就说它,❌ 只说「回合未能完成」让人点开猜。
const SAID = '咕咕积分用完了。充值后再发一次，或等下个周期额度刷新。'
const failedWithSaid: TurnOutcomeItem = {
  kind: 'turn-outcome',
  turnId: TURN_ID,
  id: `${TURN_ID}:outcome`,
  outcome: {
    kind: 'error',
    reason: 'prompt_failed',
    said: SAID,
    detail: `{"error":{"message":"${SAID}","type":"invalid_request_error","param":"","code":"credits_exhausted"}}\ncode=-32603, codexErrorInfo=other`,
  },
  prompt: '把这段东西读一遍',
}

describe('上游说了什么,那一行就说什么(#7103)', () => {
  it('收起时:那一行是上游那句,不是笼统的「回合未能完成」;原文照旧只在展开后', async () => {
    const said = await read(turnOutcomeUnitDef, failedWithSaid, false)
    const generic = await read(turnOutcomeUnitDef, failedWithDetail, false)
    expect(said.text).toContain(SAID)
    // 阴控:没有 said 的同一种失败,那一行不会凭空冒出这句(判据读的是 said 这一格,不是 detail)。
    expect(generic.text).not.toContain(SAID)
    expect(said.text).not.toContain('codexErrorInfo')
    expect(said.computed).toBe(ROW_H)
    expect(said.dom).toBe(said.computed)
  })

  it('宽档 760px:网关那一整句放得下就整句显示,「怎么办」那半句不被截掉', async () => {
    const MEMBER = '咕咕 DeepSeek V4.1 Flash 要开会员才能用。换个模型，或开通会员后再发一次。'
    let clipped = -1
    await renderAndMeasureUnit(
      turnOutcomeUnitDef,
      { ...failedWithSaid, outcome: { ...failedWithSaid.outcome, said: MEMBER } } as TurnOutcomeItem,
      makeContractCtx({ width: 760 }),
      (host) => {
        const reason = host.querySelector<HTMLElement>('[data-slot="turn-outcome-reason"]')
        if (!reason || !reason.textContent?.includes(MEMBER)) throw new Error('原因那一截不在 DOM 里或不是这句 —— 这次读数是空的,不是阴性')
        clipped = reason.scrollWidth - reason.clientWidth
        return { clipped }
      },
      { onRestorePrompt: () => {} }
    )
    expect(clipped, `原因那一截被截掉了 ${clipped}px`).toBeLessThanOrEqual(0)
  })

  it('窄档 480px:一整句上游的话也给失败作用域记号线留出跨度(线留最小跨度,让路的是徽章的省略号)', async () => {
    let ratio = -1
    let ruleW = -1
    await renderAndMeasureUnit(
      turnOutcomeUnitDef,
      { ...failedWithSaid, outcome: { ...failedWithSaid.outcome, said: SAID.repeat(4) } } as TurnOutcomeItem,
      makeContractCtx({ width: 480 }),
      (host) => {
        const rule = host.querySelector('[data-slot="turn-outcome-rule"]')
        if (!rule) throw new Error('那条作用域记号线不在 DOM 里 —— 这次读数是空的,不是阴性')
        const r = rule.getBoundingClientRect()
        ruleW = Math.round(r.width * 100) / 100
        ratio = r.height > 0 ? r.width / r.height : 0
        return { ruleW, ratio }
      },
      { onRestorePrompt: () => {} }
    )
    expect(ratio, `那条线量出来 ${ruleW}px 宽 —— 长句把它的剩余空间吃掉了`).toBeGreaterThanOrEqual(8)
  })
})

// ── 变异对照 ──────────────────────────────────────────────────────────────────

/** 修之前那一行的样子:detail 只进 `title`,没有任何展开路径。 */
const tooltipOnlyDef = defineUnit<TurnOutcomeItem, { rowH: number }>({
  kind: 'turn-outcome',
  margin: { top: 8, bottom: 4 },
  vars: { rowH: ROW_H },
  measure(_data, _ctx, vars_) {
    return vars_.rowH
  },
  Render(props) {
    const detail = () =>
      props.data.outcome.kind === 'error' ? (props.data.outcome.detail ?? '') : ''
    return (
      <div
        data-slot="turn-outcome"
        data-outcome="error"
        role="alert"
        class={outcomeRow}
        style={{ height: `${props.vars.rowH}px` }}
      >
        <span data-slot="turn-outcome-badge" title={detail()}>
          <span data-slot="turn-outcome-label">Turn failed</span>
          <span data-slot="turn-outcome-reason">the prompt could not be delivered</span>
        </span>
      </div>
    )
  },
})

describe('变异对照:把 detail 放回 tooltip,判据必须红在「上得了屏幕」这一项', () => {
  it('红在目标项', async () => {
    const r = await read(tooltipOnlyDef, failedWithDetail, true)
    expect(
      r.text.includes('input_error_code=input_too_large'),
      'tooltip-only 的那一版也被判成「原文上了屏幕」—— 上面每一条绿都不算数'
    ).toBe(false)
  })

  it('非目标合取项在同一侧保持绿', async () => {
    const r = await read(tooltipOnlyDef, failedWithDetail, true)
    // 它确实画了摘要、高度也量得准 —— 变异只动了「原文上不上屏幕」这一个变量。
    expect(r.text).toContain('the prompt could not be delivered')
    expect(r.dom).toBe(r.computed)
  })
})
