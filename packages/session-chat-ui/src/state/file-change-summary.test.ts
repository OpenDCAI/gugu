import { describe, expect, it } from 'vitest'
import { fileChangeSummary } from './file-change-summary'
import type { ChatItem } from '../model'
const turn = (items: ChatItem[]) => ({ items })
const diff = (id: string, path: string, oldText: string | null, newText: string) =>
  ({ kind: 'diff', id, path, oldText, newText, status: 'done' }) as const
describe('settled turn file changes', () => {
  it('groups five actual paths and composes a create followed by an exact edit without double counting', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      diff(`d${i}`, `/r/file-${i}.txt`, null, 'one')
    )
    const result = fileChangeSummary(
      [turn([...items, diff('next', '/r/file-0.txt', 'one', 'two')])],
      't1'
    )
    expect(result?.files).toHaveLength(5)
    expect(result?.files[0]).toMatchObject({
      adds: 1,
      dels: 0,
      diffs: [{ oldText: null, newText: 'two' }]
    })
  })
  it('keeps independent replaced regions separate and different paths with the same basename distinct', () => {
    const result = fileChangeSummary(
      [
        turn([
          diff('a', '/a/index.ts', 'old', 'new'),
          diff('b', '/b/index.ts', null, 'b'),
          diff('c', '/a/index.ts', 'other', 'next')
        ])
      ],
      't1'
    )
    expect(result?.files.map((f) => f.path)).toEqual(['/a/index.ts', '/b/index.ts'])
    expect(result?.files[0]).toMatchObject({ adds: 2, dels: 2 })
    expect(result?.files[0].diffs).toHaveLength(2)
  })
  it('does not claim proposed, failed, running or subagent edits have completed', () => {
    const base = diff('a', '/a', null, 'x')
    expect(
      fileChangeSummary(
        [
          turn([
            { ...base, status: 'running' },
            { ...base, status: 'error' },
            { ...base, awaitingPermission: true },
            { ...base, parentId: 'child' },
            { ...base, parentToolCallId: 'child' } as ChatItem
          ])
        ],
        't1'
      )
    ).toBeNull()
  })
})

it('equal fragment bytes at different positions do not prove a full-file chain', () => {
  const result = fileChangeSummary(
    [turn([diff('a', '/r/file', 'A', 'B'), diff('b', '/r/file', 'B', 'C')])],
    't1'
  )
  expect(result?.files[0].diffs).toHaveLength(2)
  expect(result?.files[0]).toMatchObject({ adds: 2, dels: 2 })
  expect(result?.files[0].diffs.map(({ oldText, newText }) => [oldText, newText])).toEqual([
    ['A', 'B'],
    ['B', 'C']
  ])
})
