import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@session-chat/model'
import { tallyToolRun, toolRunLabel, toolRunNow, toolRunNowLabel } from './tool-run'
import { defaultChatTranslator } from '@session-chat/localization'
import type { TranscriptTurn } from '@session-chat/model'
import { unit } from '@session-chat/core/units'
import type { ItemSegmenter, SegmentCtx, SegmentItem } from '@session-chat/core/units'
import { flattenTier } from './flatten'

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

describe('what a running run is doing right now (toolRunNow)', () => {
  const run = (id: string, command: string, status = 'running'): ChatItem =>
    ({ kind: 'execute-tool-call', id, command, status }) as unknown as ChatItem
  const thought = (id: string, status = 'thinking'): ChatItem =>
    ({ kind: 'thinking', id, text: '', status }) as unknown as ChatItem

  it('names the running command, collapsed like the command chip; thinking when only thinking is live; nothing once settled', () => {
    expect(toolRunNow([execute('a'), run('b', 'sleep   10\n')])).toEqual({ kind: 'command', command: 'sleep 10' })
    expect(toolRunNow([execute('a'), thought('t')])).toEqual({ kind: 'thinking' })
    // A running command is the more concrete answer than "thinking".
    expect(toolRunNow([thought('t'), run('b', 'sleep 10')])).toEqual({ kind: 'command', command: 'sleep 10' })
    expect(toolRunNow([execute('a'), thought('t', 'done'), run('b', 'sleep 10', 'done')])).toBeNull()
    const group = { kind: 'tool-group', id: 'g', status: 'running', children: [read('r'), run('b', 'npm test')] } as unknown as ChatItem
    expect(toolRunNow([group])).toEqual({ kind: 'command', command: 'npm test' })
    // A running command with no text says nothing rather than an empty chip.
    expect(toolRunNow([run('b', '  ')])).toBeNull()
    expect(toolRunNowLabel({ kind: 'command', command: 'x' }, defaultChatTranslator)).toBe('running')
    expect(toolRunNowLabel({ kind: 'thinking' }, defaultChatTranslator)).toBe('thinking')
  })

  it('the live run carries it; the same run settled does not (it goes back to the plain count)', () => {
    const passthrough = new Proxy({} as Record<string, ItemSegmenter>, {
      get: (_t, kind: string) => ({ kind, segment: (item: SegmentItem) => [unit(item.kind, item, item, { key: 'self' })] }),
    })
    const ctx = (active: boolean) => ({ caches: {}, expanded: () => false, active, plan: () => null, translate: defaultChatTranslator,
      pendingToolCallIds: () => new Set<string>(), terminalOutputText: () => null, terminalExitStatus: () => null }) as unknown as SegmentCtx
    const user = { kind: 'message', id: 'u', seq: 0, role: 'user', text: 'go' } as ChatItem
    const turn = (items: ChatItem[], done: boolean) =>
      ({ id: 't', seq: 1, initiator: 'user', items: [user, ...items], ...(done ? { outcome: { kind: 'done' } } : {}) }) as unknown as TranscriptTurn
    const runRow = (units: ReturnType<typeof flattenTier>) => units.find((u) => u.kind === 'tool-run')?.data as { now?: unknown; live?: boolean }
    const live = runRow(flattenTier([turn([thought('t1', 'done'), execute('a'), thought('t2', 'done'), run('b', 'sleep 10')], false)], ctx(true), passthrough))
    expect(live).toMatchObject({ live: true, now: { kind: 'command', command: 'sleep 10' } })
    // Same rows, every step finished (between steps, or the turn about to settle): the plain count again.
    const idle = runRow(flattenTier([turn([thought('t1', 'done'), execute('a'), thought('t2', 'done'), run('b', 'sleep 10', 'done')], false)], ctx(true), passthrough))
    expect(idle).toBeDefined()
    expect(idle.live).toBeFalsy()
    expect(idle.now).toBeUndefined()
  })
})

