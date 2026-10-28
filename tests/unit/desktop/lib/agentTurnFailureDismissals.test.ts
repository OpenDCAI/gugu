// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { readAgentTurnFailureDismissals, writeAgentTurnFailureDismissals } from '../../../../apps/desktop/src/lib/agentTurnFailureDismissals'

const DAY = 24 * 60 * 60 * 1000
beforeEach(() => window.localStorage.clear())

describe('失败条「关掉」的记录', () => {
  it('按用户存、读回同样的内容；没有记录时为空', () => {
    expect(readAgentTurnFailureDismissals('u1')).toEqual({})
    writeAgentTurnFailureDismissals('u1', { cmd: { revision: 'r1', at: 1000 } }, 1000)
    expect(readAgentTurnFailureDismissals('u1')).toEqual({ cmd: { revision: 'r1', at: 1000 } })
    expect(readAgentTurnFailureDismissals('u2')).toEqual({})
  })
  it('只留 30 天内、最新的 200 条', () => {
    const now = 100 * DAY
    const many = Object.fromEntries(Array.from({ length: 205 }, (_, n) => [`c${n}`, { revision: 'r', at: now - n }]))
    writeAgentTurnFailureDismissals('u1', { ...many, old: { revision: 'r', at: now - 31 * DAY } }, now)
    const kept = readAgentTurnFailureDismissals('u1')
    expect(Object.keys(kept)).toHaveLength(200)
    expect(kept.old).toBeUndefined()
    expect(kept.c204).toBeUndefined()
    expect(kept.c0).toBeDefined()
  })
  it('读坏了抛错（由调用方当作没关过），条目里坏掉的字段丢掉', () => {
    window.localStorage.setItem('gugu.agent-turn-failure-dismissed.u1', '[1')
    expect(() => readAgentTurnFailureDismissals('u1')).toThrow()
    window.localStorage.setItem('gugu.agent-turn-failure-dismissed.u1', JSON.stringify({ a: { revision: 5, at: 1 }, b: { revision: null, at: 2 } }))
    expect(readAgentTurnFailureDismissals('u1')).toEqual({ b: { revision: null, at: 2 } })
  })
})
