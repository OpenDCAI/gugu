import { describe, expect, it } from 'vitest'
import { GuguEngine } from '@/components/agentAvatar/engine/engine'
import {
  BLINK_CADENCE,
  EXPRESSION_CADENCE,
  type DisplayStateId,
  type ExpressionId,
  expressionPool,
  nextPoolIndex
} from '@/components/agentAvatar/engine/spec'

const STEP = 1 / 60

/** 跑 seconds 秒,收集表情变化的时刻(engine.expression 每变一次记一笔) */
function simulate(state: DisplayStateId | null, seconds: number, seed = 7, rest?: ExpressionId) {
  const engine = new GuguEngine(seed)
  if (rest) engine.setExpression(rest)
  engine.setState(state)
  const changes: { t: number; id: string | null }[] = []
  let last: string | null = null
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    engine.update(STEP, null)
    if (engine.expression !== last) {
      last = engine.expression
      changes.push({ t: i * STEP, id: last })
    }
  }
  return changes
}

/** 数「眼睛合上」的次数:blinkC 从 <0.5 升到 >=0.5 算一次(跳过进状态那一下带的强制眨眼) */
function countBlinks(state: DisplayStateId | null, seconds: number, seed = 5) {
  const engine = new GuguEngine(seed)
  engine.setState(state)
  let blinks = 0
  let closed = false
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    engine.update(STEP, null)
    if (i * STEP < 2.5) continue
    const c = (engine as unknown as { blinkC: number }).blinkC
    if (!closed && c >= 0.5) {
      closed = true
      blinks++
    } else if (closed && c < 0.2) closed = false
  }
  return blinks
}

/** 每段脸停了多久(最后一段没停完,不算) */
function holds(changes: { t: number; id: string | null }[]) {
  const out: { id: string | null; dur: number }[] = []
  for (let i = 0; i < changes.length - 1; i++)
    out.push({ id: changes[i].id, dur: changes[i + 1].t - changes[i].t })
  return out
}

const EPS = 0.05

describe('agent avatar expression pools & cadence(本位脸 + 短暂走神,引擎自己定时)', () => {
  it('nextPoolIndex:在本位就去一个走神的脸,在走神就回本位', () => {
    for (const len of [2, 3, 5]) {
      for (const r of [0, 0.2, 0.5, 0.99999]) {
        const away = nextPoolIndex(len, 0, r)
        expect(away).toBeGreaterThanOrEqual(1)
        expect(away).toBeLessThan(len)
        expect(nextPoolIndex(len, away, r)).toBe(0)
      }
    }
    expect(nextPoolIndex(1, 0, 0.5)).toBe(0)
  })

  it('每个有节律的状态都有池,且至少两个不同表情', () => {
    for (const state of Object.keys(EXPRESSION_CADENCE) as DisplayStateId[]) {
      const pool = expressionPool(state, 'neutral')
      expect(pool, state).not.toBeNull()
      expect(new Set(pool).size, state).toBeGreaterThanOrEqual(2)
    }
  })

  it('出错 / 不在线 / 已移除 / 无 不轮换', () => {
    for (const state of ['error', 'offline', 'removed', 'none'] as const) {
      expect(EXPRESSION_CADENCE[state]).toBeUndefined()
      expect(expressionPool(state, 'neutral')).toBeNull()
    }
  })

  it('待机池以这只 agent 的休息表情打头,旁边配另一个', () => {
    expect(expressionPool('idle', 'neutral')).toEqual(['neutral', 'curious'])
    expect(expressionPool('online', 'proud')).toEqual(['proud', 'curious'])
    expect(expressionPool('idle', 'curious')).toEqual(['curious', 'neutral'])
  })

  it('身体变成「!」/ 后台三颗点时不眨眼;待机有自己的眨眼间隔', () => {
    for (const s of ['parked', 'needsApproval', 'needsAnswer', 'needsPlanReview', 'needsAction'] as const) {
      expect(BLINK_CADENCE[s], s).toBeNull()
    }
    expect(BLINK_CADENCE.idle).toEqual([4, 9])
  })

  it('待机 180 秒:本位脸(休息表情)每次停 10–18 秒,走神 3–6 秒就回来,只在池里换', () => {
    const changes = simulate('idle', 180, 7, 'proud')
    const pool = expressionPool('idle', 'proud')!
    expect(changes[0].id).toBe('proud')
    expect(changes.every((c) => pool.includes(c.id as ExpressionId))).toBe(true)
    const hs = holds(changes)
    expect(hs.length).toBeGreaterThanOrEqual(8)
    for (const h of hs) {
      const [lo, hi] = h.id === 'proud' ? EXPRESSION_CADENCE.idle!.home : EXPRESSION_CADENCE.idle!.away
      expect(h.dur, `${h.id} held ${h.dur}`).toBeGreaterThanOrEqual(lo - EPS)
      expect(h.dur, `${h.id} held ${h.dur}`).toBeLessThanOrEqual(hi + EPS)
    }
    // 本位与走神交替:每次走神之后一定回到本位
    for (let i = 1; i < changes.length; i++) {
      if (changes[i - 1].id !== 'proud') expect(changes[i].id).toBe('proud')
    }
    // 本位占大头
    const home = hs.filter((h) => h.id === 'proud').reduce((a, h) => a + h.dur, 0)
    const total = hs.reduce((a, h) => a + h.dur, 0)
    expect(home / total).toBeGreaterThan(0.6)
  })

  it('运行中 40 秒:专注是本位,走神在「怀疑 / 好奇」两个里随机,两个都出现过', () => {
    const changes = simulate('running', 40)
    expect(changes[0].id).toBe('attentive')
    const seen = new Set(changes.map((c) => c.id))
    expect(seen).toEqual(new Set(['attentive', 'suspicious', 'curious']))
    for (const h of holds(changes)) {
      const [lo, hi] =
        h.id === 'attentive' ? EXPRESSION_CADENCE.running!.home : EXPRESSION_CADENCE.running!.away
      expect(h.dur).toBeGreaterThanOrEqual(lo - EPS)
      expect(h.dur).toBeLessThanOrEqual(hi + EPS)
    }
  })

  it('出错状态脸不轮换:只有 害怕 → 委屈 两次', () => {
    expect(simulate('error', 40).map((c) => c.id)).toEqual(['scared', 'woe'])
  })

  it('换状态后从新状态的本位脸开始', () => {
    const engine = new GuguEngine(3)
    engine.setState('running')
    for (let i = 0; i < 60 * 20; i++) engine.update(STEP, null)
    engine.setState('needsApproval')
    engine.update(STEP, null)
    expect(engine.expression).toBe('curious')
  })

  it('待机 300 秒眨眼次数落在 4–9 秒一次(含偶尔的连眨)', () => {
    const n = countBlinks('idle', 300)
    expect(n).toBeGreaterThanOrEqual(300 / 9 - 3)
    expect(n).toBeLessThanOrEqual((300 / 4) * 1.25)
  })

  it('等你批准 / 后台运行 60 秒一次都不眨', () => {
    expect(countBlinks('needsApproval', 60)).toBe(0)
    expect(countBlinks('parked', 60)).toBe(0)
  })
})
