/** @jsxImportSource solid-js */
/**
 * 失败记号的**作用域可分性**契约（#3568）。
 *
 * # 这条判据读的是什么
 *
 * 一次工具调用失败与一个 turn 失败是**两条独立的通道**：前者由 agent 的 `session/update`
 * 报上来，后者是 `prompt()` 这一整轮抛出来的（`acp-agents/session/cell.ts:559-573`）。
 * 两者互不蕴含，所以同一屏上同时出现两个记号是正常的、也是应该的。缺陷不是"说了两遍"，
 * 而是**说的时候用了同一枚字形**：#3560 那一屏里，工具行右端和收尾行左端各画一个一模一样的
 * 红 `⊗`，一个管这一次调用、一个管整轮，而读者手上没有任何线索去分辨谁管谁。
 *
 * ⇒ 这里读的不是"红色出现了几次"。**只数颜色的判据会被"把其中一个删掉"满足，而删掉不是修好。**
 * 读的是：两个作用域各自的记号仍然在（阳性对照），而它们的**字形集合互不相交**（目标项）。
 *
 * # ⚠️ 一个会满足 DOM 判据却仍然分不清的实现长什么样
 *
 * 把两枚 `⊗` 换成两枚**不同但都很像叉**的字形 —— DOM 上可分，屏幕上仍然分不清。
 * 所以这里还有一条**形状**判据：tool 级的记号必须是**点**（近似方、≤ 24px），
 * turn 级的记号必须是**跨度**（发丝高、宽高比 ≥ 8）。一枚换过的字形仍然是点，过不了它。
 * ⚠️ 这条契约跑在 480px 的裸 host 上，那里余量足够，跨度线一定画得出来；产品最窄那一档
 * （transcript 只剩约 474px）线会按设计归零，那一档由 e2e 自己判 —— 见
 * `e2e/electron/task-failure-scope-3568.spec.ts`(#6270 已删) 里 trail 的「真跨度 / 整条归零」两态判据。
 * 而人能不能真的一眼分开，只有真渲染截图能答 —— 那半在 `e2e/electron/task-failure-scope-3568.spec.ts`(#6270 已删)。
 *
 * # 变异对照
 *
 * 最后一个 describe 挂着一条**故意撞车**的收尾行：它用的是真的 `IconError` 组件，
 * 所以判据永远跟着那枚字形走。它要求探测器在那一侧**红在字形相交这一项上**，
 * 而阳性对照（两侧记号都在、形状分别是点与跨度、两者同色）在同一侧**保持绿** ——
 * 否则这条变异动的就不止一个变量，证不了"判据判的是那个变量"。
 */

import { ROW_H } from '@session-chat/components/engine/row-metrics'
import { IconError } from '@session-chat/components/primitives/icons'
import { toolUnitDef } from '@session-chat/components/rows/tools/tool/tool.def'
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def'
import { outcomeRow, outcomeRuleTrail } from '@session-chat/components/rows/turn-outcome/turn-outcome.css'
import { defineUnit } from '@session-chat/core/units'
import type { ChatToolCall, TurnOutcomeItem } from '@session-chat/model'
import { vars } from '@session-chat/styles/theme.css'
import { describe, expect, it } from 'vitest'
import { makeContractCtx, renderAndMeasureUnit } from './contract'

const WIDTH = 480

/** 失败的工具调用 —— 原因走 ACP 真正投递它的那条字段（`result`），不是 `error`。 */
const failedTool: ChatToolCall = {
  kind: 'tool',
  id: 'scope-tool-failed',
  name: 'fetch_design_reference',
  status: 'error',
  inputSummary: 'https://example.invalid/reference',
  result: 'connect ECONNREFUSED 10.0.0.9:443'
}

const failedTurn: TurnOutcomeItem = {
  kind: 'turn-outcome',
  turnId: 'turn-failed',
  id: 'scope-turn-failed',
  outcome: {
    kind: 'error',
    reason: 'prompt_failed',
    detail: '{"error":{"message":"参数非法","type":"upstream_error","code":"1210"}}',
  },
  prompt: '把设计稿里的间距对一遍'
}

/** 宿主接了回调 ⇒ 收尾行会渲染「取回指令」，连同它自己那枚**合法的** turn 级字形。 */
const HOST_COMMANDS = { onRestorePrompt: () => {} }

// ── 读数 ──────────────────────────────────────────────────────────────────────

type Box = { w: number; h: number }

type ScopeReading = {
  /** 这个作用域画出来的每一枚字形的**几何指纹**。 */
  glyphs: string[]
  /** 与每枚字形一一对应的边界盒。 */
  glyphBoxes: Box[]
  /** 这个作用域的跨度记号（发丝线）的边界盒。 */
  ruleBoxes: Box[]
  /** 承担「这里出错了」的那段文字的 computed color。 */
  markColor: string
  /** 收尾行自己的 surface；透明会让底下的流式正文透出来。 */
  rowBackground: string
}

/**
 * 一枚 svg 的几何指纹。
 *
 * 取的是**子元素的几何属性**（circle 的 cx/cy/r、path 的 d …），不是元素身份也不是 class：
 * 两个渲染出来一模一样的叉，无论挂在哪个 slot 下、叫什么名字，指纹都相同。
 * ⚠️ 空指纹（svg 里没有任何带几何属性的子元素）视为仪器失败而不是"没撞车"——
 * 否则一个读不出东西的探测器会在两侧都返回 `''`，看起来像"处处都撞车"或"处处都不撞"。
 */
function glyphFingerprint(svg: Element): string {
  const parts = Array.from(svg.querySelectorAll('*')).map((node) => {
    const attrs = Array.from(node.attributes)
      .filter((attribute) => attribute.name !== 'class')
      .map((attribute) => `${attribute.name}=${attribute.value}`)
      .sort()
    return `${node.tagName}[${attrs.join(',')}]`
  })
  const fingerprint = parts.join('|')
  if (!fingerprint) {
    throw new Error(
      `glyph fingerprint came out empty for <${svg.tagName}> — the reader found no geometry, ` +
        'so every comparison below would be vacuous'
    )
  }
  return fingerprint
}

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect()
  return { w: Math.round(rect.width * 100) / 100, h: Math.round(rect.height * 100) / 100 }
}

function readScope(host: HTMLElement, markSelector: string, ruleSelector: string): ScopeReading {
  const glyphNodes = Array.from(host.querySelectorAll('svg'))
  const mark = host.querySelector(markSelector)
  if (!mark) {
    throw new Error(`no element matched ${markSelector} — this reading is void, not negative`)
  }
  return {
    glyphs: glyphNodes.map(glyphFingerprint),
    glyphBoxes: glyphNodes.map(boxOf),
    ruleBoxes: Array.from(host.querySelectorAll(ruleSelector)).map(boxOf),
    markColor: getComputedStyle(mark).color,
    rowBackground: getComputedStyle(host.querySelector('[data-slot="turn-outcome"]') ?? host)
      .backgroundColor,
  }
}

async function readToolScope(): Promise<ScopeReading> {
  let reading: ScopeReading | null = null
  await renderAndMeasureUnit(
    toolUnitDef,
    failedTool,
    makeContractCtx({ width: WIDTH }),
    (host) => {
      reading = readScope(host, '[data-slot="tool-call-error-mark"]', '[data-slot="never-matches"]')
      return {}
    }
  )
  if (!reading) throw new Error('the tool scope produced no reading')
  return reading
}

async function readTurnScope(
  def: typeof turnOutcomeUnitDef = turnOutcomeUnitDef
): Promise<ScopeReading> {
  let reading: ScopeReading | null = null
  await renderAndMeasureUnit(
    def,
    failedTurn,
    makeContractCtx({ width: WIDTH }),
    (host) => {
      reading = readScope(
        host,
        '[data-slot="turn-outcome-label"]',
        '[data-slot="turn-outcome-rule"]'
      )
      return {}
    },
    HOST_COMMANDS
  )
  if (!reading) throw new Error('the turn scope produced no reading')
  return reading
}

/** ruleBoxes 为空时不返回 0 —— 那会把"没读到"伪造成一条读数。 */
function widestRule(rules: Box[]): Box {
  if (rules.length === 0) throw new Error('no rule was read; there is nothing to judge')
  return rules.reduce((widest, rule) => (rule.w > widest.w ? rule : widest))
}

function shared(a: string[], b: string[]): string[] {
  const right = new Set(b)
  return a.filter((value) => right.has(value))
}

// ── 契约 ──────────────────────────────────────────────────────────────────────

describe('failure marks say which scope they answer for (#3568)', () => {
  it('tool 级与 turn 级的字形集合互不相交', async () => {
    const tool = await readToolScope()
    const turn = await readTurnScope()

    // 阳性对照先行：两侧各自都真的画了记号。少了任何一侧，下面那条"不相交"就是平凡真，
    // 而"把其中一个删掉"恰好是这条判据必须拒绝的那种实现。
    expect(tool.glyphs.length, 'the failed tool row drew no glyph at all').toBeGreaterThanOrEqual(1)
    expect(
      turn.ruleBoxes.length,
      'the outcome row drew no scope mark — it must still announce that the turn ended badly'
    ).toBe(1)

    // 目标项。
    const collisions = shared(tool.glyphs, turn.glyphs)
    expect(
      collisions,
      `the same glyph is drawn at both scopes — one answers for this call, the other for the whole ` +
        `turn, and nothing on screen tells them apart. shared fingerprints: ${JSON.stringify(collisions)}`
    ).toEqual([])
  })

  it('tool 级的记号是点，turn 级的记号是跨度', async () => {
    const tool = await readToolScope()
    const turn = await readTurnScope()

    // 一枚"不同但仍然很像叉"的字形能过上面那条，却过不了这条：它仍然是一个点。
    for (const box of tool.glyphBoxes) {
      const ratio = box.w / box.h
      expect(
        ratio,
        `a tool-scope mark measured ${box.w}×${box.h} — the row status slot holds points, not spans`
      ).toBeGreaterThan(0.5)
      expect(ratio).toBeLessThan(2)
      expect(Math.max(box.w, box.h)).toBeLessThanOrEqual(24)
    }

    const rule = widestRule(turn.ruleBoxes)
    expect(rule.h, `the turn-scope mark is ${rule.h}px tall — a hairline, not a box`).toBeLessThanOrEqual(2)
    expect(
      rule.w / rule.h,
      `the turn-scope mark measured ${rule.w}×${rule.h} (ratio ${(rule.w / rule.h).toFixed(1)}) — ` +
        'it has to read as a span, which is the whole difference from a point'
    ).toBeGreaterThanOrEqual(8)
  })

  it('两个作用域用的是同一个红 —— 修可分性不许顺手把调色板变宽', async () => {
    const tool = await readToolScope()
    const turn = await readTurnScope()

    // 仪器对照：读到的必须是一个真的解析过的颜色，不是空串或 `inherit`。
    expect(tool.markColor, 'the tool mark colour did not resolve').toMatch(/^rgba?\(/)
    expect(
      turn.markColor,
      'the outcome row wording is not painted in the same error colour the tool mark uses — ' +
        'a second red is exactly the fix this ticket rules out'
    ).toBe(tool.markColor)
  })

  it('边界线用的是分隔线颜色，不是失败色', async () => {
    let ruleColor = ''
    let labelColor = ''
    await renderAndMeasureUnit(
      turnOutcomeUnitDef,
      failedTurn,
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const rule = host.querySelector('[data-slot="turn-outcome-rule"]')
        const label = host.querySelector('[data-slot="turn-outcome-label"]')
        if (!rule || !label) throw new Error('the outcome row rendered without its rule or label')
        ruleColor = getComputedStyle(rule).backgroundColor
        labelColor = getComputedStyle(label).color
        return {}
      },
      HOST_COMMANDS
    )
    expect(ruleColor, 'the rule colour did not resolve').toMatch(/^rgba?\(/)
    expect(
      ruleColor,
      'the boundary rule is painted in the failure colour — that stacks a fourth red into the very ' +
        'spot this ticket is about. The span says scope; the wording says severity.'
    ).not.toBe(labelColor)
  })

  it('收尾提示有自己的不透明 surface，不透出正文', async () => {
    const reading = await readTurnScope()
    expect(reading.rowBackground, 'the outcome row is still transparent').not.toBe(
      'rgba(0, 0, 0, 0)'
    )
  })

  it('收尾行的几何没有因为换记号而改变', async () => {
    const reading = await renderAndMeasureUnit(
      turnOutcomeUnitDef,
      failedTurn,
      makeContractCtx({ width: WIDTH }),
      undefined,
      HOST_COMMANDS
    )
    expect(reading.dom, 'the outcome row no longer renders at its measured height').toBe(
      reading.computed
    )
    expect(reading.computed, 'the outcome row must stay a constant ROW_H').toBe(ROW_H)
    expect(reading.spill, 'the outcome row spills past the width it was measured at').toBeLessThan(1)
  })

  it('错误详情保留在徽章的悬浮提示中，不挤进紧凑文案', async () => {
    await renderAndMeasureUnit(
      turnOutcomeUnitDef,
      failedTurn,
      makeContractCtx({ width: WIDTH }),
      (host) => {
        const badge = host.querySelector('[data-slot="turn-outcome-badge"]')
        if (!badge) throw new Error('the outcome badge was not rendered')
        expect(badge.getAttribute('title')).toBe(
          '{"error":{"message":"参数非法","type":"upstream_error","code":"1210"}}'
        )
        expect(badge.textContent).not.toContain('1210')
        // aria-label 整条顶掉可见文案的无障碍名 ⇒ 它必须**自己**带上两截话,
        // 否则读屏用户会丢掉「这一轮怎么了」那半句(可见文本里仍在)。
        const aria = badge.getAttribute('aria-label') ?? ''
        expect(aria).toContain('1210')
        for (const visible of Array.from(
          badge.querySelectorAll('[data-slot="turn-outcome-label"], [data-slot="turn-outcome-reason"]')
        )) {
          expect(aria, 'aria-label dropped a visible part of the badge').toContain(
            (visible.textContent ?? '').trim()
          )
        }
        return {}
      },
      HOST_COMMANDS
    )
  })
})

// ── 变异对照 ──────────────────────────────────────────────────────────────────

/**
 * 修之前那一行的样子：真的 `IconError` 回到收尾行里。
 *
 * ⚠️ 它导入的是**真组件**，所以哪天有人改了那枚字形，撞车的两侧会一起动 ——
 * 这条对照不会退化成一份抄来的、会漂的常量。
 */
const collidingTurnOutcomeDef = defineUnit<TurnOutcomeItem, { rowH: number }>({
  kind: 'turn-outcome',
  margin: { top: 4, bottom: 4 },
  vars: { rowH: ROW_H },
  measure(_data, _ctx, vars_) {
    return vars_.rowH
  },
  Render(props) {
    return (
      <div
        data-slot="turn-outcome"
        data-outcome="error"
        role="alert"
        class={outcomeRow}
        style={{ height: `${props.vars.rowH}px`, color: vars.fgError }}
      >
        <span data-slot="turn-outcome-icon" aria-hidden="true" style={{ display: 'inline-flex' }}>
          <IconError />
        </span>
        <span data-slot="turn-outcome-label">这一轮失败了</span>
        <span data-slot="turn-outcome-rule" data-rule="trail" aria-hidden="true" class={outcomeRuleTrail} />
      </div>
    )
  }
})

describe('变异对照：把同一枚字形放回 turn 级，探测器必须红在字形相交这一项上', () => {
  it('红在目标项', async () => {
    const tool = await readToolScope()
    const turn = await readTurnScope(collidingTurnOutcomeDef)
    expect(
      shared(tool.glyphs, turn.glyphs).length,
      'the detector cannot see a collision even when the very same IconError is drawn at both ' +
        'scopes — every green above is worthless until this line is red on collision'
    ).toBeGreaterThanOrEqual(1)
  })

  it('非目标合取项在同一侧保持绿', async () => {
    const tool = await readToolScope()
    const turn = await readTurnScope(collidingTurnOutcomeDef)

    // 两侧记号都在。
    expect(tool.glyphs.length).toBeGreaterThanOrEqual(1)
    expect(turn.ruleBoxes.length).toBe(1)
    // 形状分别是点与跨度。
    for (const box of tool.glyphBoxes) {
      expect(box.w / box.h).toBeGreaterThan(0.5)
      expect(box.w / box.h).toBeLessThan(2)
    }
    const rule = widestRule(turn.ruleBoxes)
    expect(rule.h).toBeLessThanOrEqual(2)
    expect(rule.w / rule.h).toBeGreaterThanOrEqual(8)
    // 同一个红。
    expect(turn.markColor).toBe(tool.markColor)
  })
})
