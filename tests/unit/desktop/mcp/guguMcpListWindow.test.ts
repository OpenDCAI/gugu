import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_FILTER_WORDS,
  LIST_DEFAULT_ROWS,
  matchesAgentStatus,
  parseRows,
  windowList,
  withoutListArgs,
} from '../../../../apps/desktop/electron/mcp/list-window.mjs'
import { AGENT_STATUSES, AGENT_STATUS_DETAILS } from '../../../../packages/core/src/shared/agentStatus'

// 列表类工具的共同约定(spec im-mcp):rows 取哪一段、name 按名字筛、返回 total / rows / next。
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Session ${i + 1}` }))
const titleOf = { namesOf: (row: { title: string }) => [row.title] }

describe('rows: a count or a 1-based inclusive range, like line numbers', () => {
  it('reads the default, a count, a range, and a bare number', () => {
    expect(parseRows(undefined)).toEqual({ from: 1, to: LIST_DEFAULT_ROWS })
    expect(parseRows('')).toEqual({ from: 1, to: LIST_DEFAULT_ROWS })
    expect(parseRows('10')).toEqual({ from: 1, to: 10 })
    expect(parseRows(10)).toEqual({ from: 1, to: 10 })
    expect(parseRows('41-60')).toEqual({ from: 41, to: 60 })
    expect(parseRows(' 41 - 60 ')).toEqual({ from: 41, to: 60 })
  })

  it('refuses what it cannot read, naming the accepted forms', () => {
    for (const bad of ['abc', '0', '0-5', '60-41', '-5', '1-', '1.5']) {
      expect(() => parseRows(bad), bad).toThrow(/rows must be a count like "20" or a range like "41-60"/)
    }
  })
})

describe('windowList', () => {
  it('first window by default: total is the whole table, next names the following window', () => {
    const out = windowList(rows(137), {}, titleOf)
    expect(out.total).toBe(137)
    expect(out.rows).toBe('1-20')
    expect(out.next).toBe('21-40')
    expect(out.items.map((row) => row.title)).toEqual(rows(20).map((row) => row.title))
  })

  it('a range returns exactly those rows; the last window has no next', () => {
    const third = windowList(rows(137), { rows: '41-60' }, titleOf)
    expect(third.items[0].title).toBe('Session 41')
    expect(third.items.at(-1)!.title).toBe('Session 60')
    expect(third.rows).toBe('41-60')
    expect(third.next).toBe('61-80')
    const tail = windowList(rows(137), { rows: '121-140' }, titleOf)
    expect(tail.rows).toBe('121-137')
    expect(tail.next).toBeNull()
    // 最后一段不足一窗:next 截到表尾,而不是给出一段注定取空的区间。
    expect(windowList(rows(30), {}, titleOf).next).toBe('21-30')
  })

  it('a window past the end is empty and says so, with the true total', () => {
    const out = windowList(rows(37), { rows: '41-60' }, titleOf)
    expect(out).toEqual({ total: 37, rows: null, next: null, items: [] })
  })

  it('name matches case-insensitively in any of the row\'s names; total counts matches, not the table', () => {
    const table = [
      { title: 'Review delivery routing', alias: 'Codex 1' },
      { title: 'Update docs', alias: 'Claude 2' },
      { title: 'review login', alias: 'Codex 3' },
    ]
    const names = { namesOf: (row: (typeof table)[number]) => [row.title, row.alias] }
    const byTitle = windowList(table, { name: 'REVIEW' }, names)
    expect(byTitle.items.map((row) => row.title)).toEqual(['Review delivery routing', 'review login'])
    expect(byTitle.total).toBe(2)
    expect(windowList(table, { name: 'claude' }, names).items.map((row) => row.title)).toEqual(['Update docs'])
    // 对照:不传 name 就是整张表
    expect(windowList(table, {}, names).total).toBe(3)
  })

  it('a tool\'s own filter composes with name and the window', () => {
    const table = rows(50).map((row, index) => ({ ...row, pinned: index % 2 === 0 }))
    const out = windowList(table, { rows: '5' }, { namesOf: (row) => [row.title], keep: (row) => row.pinned })
    expect(out.total).toBe(25)
    expect(out.items.map((row) => row.title)).toEqual(['Session 1', 'Session 3', 'Session 5', 'Session 7', 'Session 9'])
    expect(out.next).toBe('6-10')
  })

  it('a status word outside the vocabulary is refused before filtering, even when nothing would match', () => {
    const spec = { namesOf: (row: { title: string }) => [row.title], statusFilter: true }
    expect(() => windowList([], { status: 'ready' }, spec)).toThrow(/status must be one of idle, working/)
    expect(() => windowList(rows(3), { name: 'nobody', status: 'ready' }, spec)).toThrow(/status must be one of/)
    // 对照:合法的词、不传,都照常切
    expect(windowList([], { status: 'working' }, spec).total).toBe(0)
    expect(windowList(rows(3), {}, spec).total).toBe(3)
  })

  it('a catalog gives everything unless rows is passed; other lists default to the first 20', () => {
    const models = { namesOf: (row: { title: string }) => [row.title], catalog: true }
    expect(windowList(rows(37), {}, models)).toMatchObject({ total: 37, rows: '1-37', next: null })
    expect(windowList(rows(37), { rows: '10' }, models)).toMatchObject({ rows: '1-10', next: '11-20' })
    expect(windowList(rows(37), {}, titleOf)).toMatchObject({ rows: '1-20', next: '21-37' })
  })

  it('rows:"1" is enough to read a count', () => {
    const out = windowList(rows(42), { rows: '1' }, titleOf)
    expect(out.total).toBe(42)
    expect(out.items).toHaveLength(1)
  })
})

describe('agent status filter words come from the one core vocabulary', () => {
  it('is exactly the base statuses plus the details, which do not overlap', () => {
    expect(AGENT_STATUS_FILTER_WORDS).toEqual([...AGENT_STATUSES, ...AGENT_STATUS_DETAILS])
    expect(new Set(AGENT_STATUS_FILTER_WORDS).size).toBe(AGENT_STATUS_FILTER_WORDS.length)
  })

  it('matches a base status or a detail; a row with no reading matches no word', () => {
    const waiting = { status: 'needs_user', detail: 'approval' }
    expect(matchesAgentStatus(waiting, 'needs_user')).toBe(true)
    expect(matchesAgentStatus(waiting, 'approval')).toBe(true)
    expect(matchesAgentStatus(waiting, 'working')).toBe(false)
    expect(matchesAgentStatus({ status: null, detail: null }, 'idle')).toBe(false)
    expect(matchesAgentStatus({ status: null, detail: null }, undefined)).toBe(true)
  })

  it('refuses a word outside the vocabulary instead of silently matching nothing', () => {
    expect(() => matchesAgentStatus({ status: 'working', detail: 'running' }, 'busy')).toThrow(/status must be one of idle, working/)
  })
})

describe('withoutListArgs', () => {
  it('strips the list arguments and the tool\'s own filters, keeping the dispatcher\'s', () => {
    expect(withoutListArgs({ session_id: 's', rows: '5', name: 'x', status: 'working', pinned: true }, ['status', 'pinned']))
      .toEqual({ session_id: 's' })
  })
})
