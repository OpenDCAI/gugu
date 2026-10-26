import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLocalTranscript } from '../../../../../packages/core/src/local/agent/transcriptInventory'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const at = '2026-10-26T00:00:00.000Z'
async function fixture(source: 'claude-code' | 'codex', entries: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'context-projection-'))
  roots.push(root)
  const dir = join(root, source === 'codex' ? 'sessions' : 'projects')
  await mkdir(dir)
  const path = join(dir, 'fixture.jsonl')
  await writeFile(path, entries.map((entry) => JSON.stringify({ timestamp: at, ...entry as object })).join('\n'))
  return { path, options: { nativeHomes: { 'claude-code': [root], codex: [root] } } }
}

describe('the existing transcript parser context view', () => {
  it('projects Claude instructions/rendered warnings/nested memory and tool inputs without bodies or outputs', async () => {
    const { path, options } = await fixture('claude-code', [
      { type: 'attachment', sessionId: 'claude-main', cwd: '/project', attachment: { type: 'instructions', files: [{ path: '/home/MEMORY.md', type: 'AutoMem', content: 'private instruction body' }] }, rendered: [{ content: 'WARNING: MEMORY.md exceeds the limit; truncated' }] },
      { type: 'attachment', attachment: { type: 'nested_memory', path: '/project/CLAUDE.md', content: { content: 'nested private body' } } },
      { type: 'user', message: { role: 'user', content: 'Inspect the project' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/project/CLAUDE.md' } }, { type: 'thinking', thinking: '/never/reasoning.md' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '/never/output.md' }] } },
      { type: 'attachment', isSidechain: true, attachment: { type: 'instructions', files: [{ path: '/never/child.md', content: 'child' }] } },
    ])
    const context = await readLocalTranscript(path, 'claude-code', { ...options, view: 'context' })
    expect(context.loaded).toEqual([
      { path: '/home/MEMORY.md', kind: 'instruction-file', scope: 'AutoMem', chars: 24, truncated: true, at },
      { path: null, kind: 'rendered-total', scope: null, chars: 45, truncated: true, at },
    ])
    expect(context.nested).toEqual([{ path: '/project/CLAUDE.md', at }])
    expect(context.refs).toEqual(['/project/CLAUDE.md'])
    expect(JSON.stringify(context)).not.toMatch(/private|reasoning|output|child/)
    const conversation = await readLocalTranscript(path, 'claude-code', options)
    expect(conversation.turns.map((turn) => turn.content)).toEqual(['Inspect the project'])
  })

  it('uses Codex base instructions and world-state metadata, with distinct shell input refs only', async () => {
    const { path, options } = await fixture('codex', [
      { type: 'session_meta', payload: { id: 'codex-main', cwd: '/project', base_instructions: { text: 'base private text' } } },
      { type: 'world_state', payload: { full: true, state: { agents_md: { directory: '/project', text: 'project private text' }, model: 'ignored' } } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the project' }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 't', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat /project/AGENTS.md /project/AGENTS.md' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 't', output: '/never/output.md' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: '/never/reasoning.md' }] } },
    ])
    const context = await readLocalTranscript(path, 'codex', { ...options, view: 'context' })
    expect(context.loaded).toEqual([
      { path: null, kind: 'base-instructions', scope: 'Global', chars: 17, truncated: false, at },
      { path: '/project/AGENTS.md', kind: 'instruction-file', scope: 'Project', chars: 20, truncated: false, at },
    ])
    expect(context.refs).toEqual(['/project/AGENTS.md'])
    expect(context.nested).toEqual([])
    expect(JSON.stringify(context)).not.toMatch(/private|output|reasoning/)
    expect((await readLocalTranscript(path, 'codex', options)).turns).toEqual([{ role: 'user', content: 'Inspect the project', createdAt: at }])
  })
})
