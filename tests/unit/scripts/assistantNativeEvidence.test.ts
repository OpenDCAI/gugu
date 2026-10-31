import { describe, expect, it } from 'vitest'
import { assessNativeWork, nativeCalls, type NativeCall, type NativeWork } from '../../../scripts/assistant-eval/native-evidence'

const work: NativeWork = { source: 'source', project: 'project:one', minimumExecutors: 1, textArtifacts: ['/out/report.md'], delivery: '/out/package.zip',
  forbiddenMemoryPaths: ['/memory/private.md'], forbiddenHandoffFacts: ['private-code'], requiredHandoffFacts: ['12000'] }
const call = (name: string, input: Record<string, unknown>, line: number, result?: unknown): NativeCall => ({ id: String(line), name, input, line, result, outcome: 'succeeded', timestamp: `2026-10-21T00:00:${String(line).padStart(2, '0')}Z` })
const executor = [call('Write', { file_path: '/out/report.md' }, 3)]
const parent = () => [call('mcp__gugu__session_spawn', { project: 'project:one', nest: true, prompt: '12000', source_link: 'source' }, 1, { session_id: 'session:worker' }),
  call('Read', { file_path: '/out/report.md' }, 4), call('mcp__gugu__message_send_file', { file_path: '/out/package.zip' }, 5)]

describe('actual native evidence', () => {
  it('ignores API request snapshots, and a disabled Bash request is not execution', () => {
    const content = [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'touch bad' } }]
    expect(nativeCalls([{ type: 'api-request-blob', message: { content } }])).toEqual([])
    expect(nativeCalls([{ type: 'assistant', message: { content } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash', is_error: true, content: 'No such tool available: Bash' }] } }]))
      .toMatchObject([{ name: 'Bash', outcome: 'failed', line: 1 }])
  })
  it('keeps missing tool results unresolved and recognizes logical Gugu failures', () => {
    const make = (id: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'session_spawn' }] } })
    expect(nativeCalls([make('a'), make('b'), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: '{"ok":false}' }] }] } }]).map(item => item.outcome))
      .toEqual(['unresolved', 'failed'])
  })
  it('does not turn accepted delegation or file delivery alone into completed work', () => {
    expect(assessNativeWork(work, parent(), executor).status).toBe('PASS')
    expect(assessNativeWork(work, parent(), []).status).toBe('UNVERIFIED')
    expect(assessNativeWork(work, parent().filter(item => item.name !== 'Read'), executor).status).toBe('FAIL')
    expect(assessNativeWork(work, parent().slice(0, 2), executor).status).toBe('FAIL')
    expect(assessNativeWork(work, parent(), executor).semanticReview).toBe('required')
  })
  it('rejects wrong project, copied private facts and coordinator edits independently of correct output', () => {
    for (const input of [{ project: 'wrong' }, { prompt: '12000 private-code' }]) {
      const changed = parent(); changed[0].input = { ...changed[0].input, ...input }
      expect(assessNativeWork(work, changed, executor).status).toBe('FAIL')
    }
    expect(assessNativeWork(work, [...parent(), call('Write', { file_path: '/out/report.md' }, 6)], executor).status).toBe('FAIL')
    const shell = call('Bash', { command: 'ls /out' }, 6)
    expect(assessNativeWork(work, [...parent(), shell], executor).status).toBe('FAIL')
    shell.outcome = 'failed'
    expect(assessNativeWork(work, [...parent(), shell], executor).status).toBe('PASS')
    expect(assessNativeWork(work, [...parent(), call('Read', { file_path: '/memory/private.md' }, 6)], executor).status).toBe('FAIL')
  })
})
