import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@session-chat/model'
import { tallyToolRun, toolRunLabel } from './tool-run'

const read = (id: string): ChatItem =>
  ({ kind: 'read-tool-call', id, path: `src/${id}.ts`, status: 'done' }) as unknown as ChatItem

const execute = (id: string): ChatItem =>
  ({ kind: 'execute-tool-call', id, command: id, status: 'done' }) as unknown as ChatItem

const search = (id: string): ChatItem =>
  ({ kind: 'search-tool-call', id, query: id, matchCount: 99, status: 'done' }) as unknown as ChatItem

describe('tool run summaries count calls, not layout wrappers', () => {
  it('counts read-batch children as file reads', () => {
    const group = {
      kind: 'tool-group',
      id: 'read-batch',
      groupKind: 'read-batch',
      status: 'done',
      children: [read('one'), read('two'), read('three')]
    } as unknown as ChatItem

    expect(tallyToolRun([group, search('ownership'), execute('git-log')])).toEqual({
      search: 1,
      read: 3,
      execute: 1
    })
    expect(
      toolRunLabel(tallyToolRun([group, search('ownership'), execute('git-log')]), (key, values) => {
        if (key === 'transcript.toolRun.join') return ', '
        const count = values?.count ?? 0
        return `${key}:${count}`
      })
    ).toBe('Transcript.toolRun.searchOne:1, transcript.toolRun.read:3, transcript.toolRun.executeOne:1')
  })
})
