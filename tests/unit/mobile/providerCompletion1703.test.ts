import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createSessionTimeline } from '../../../packages/session-core/src/session-record/timeline'
import { createClaudeJsonlSource } from '../../../packages/session-core/src/session-record/sources/claude-jsonl'
import { createCodexJsonlSource } from '../../../packages/session-core/src/session-record/sources/codex-jsonl'
import { applySnapshot, deriveAttention, emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { canReleasePhoneInput } from '@/mobile/agent-watch/phone-input-queue'

it.each(['claude', 'codex'] as const)('settles the captured %s completion boundary without a running provider', async provider => {
  const root = await mkdtemp(join(tmpdir(), 'provider-completion-1703-'))
  const id = provider === 'claude' ? 'claude-final-fragments' : '019ed98a-a0ce-7f63-a9aa-04e0760a80c2'
  const fixture = provider === 'claude' ? 'claude-final-fragments.jsonl' : 'codex-rollout.jsonl'
  const body = await readFile(new URL(`../../../packages/session-core/src/session-record/__fixtures__/${fixture}`, import.meta.url), 'utf8')
  await writeFile(join(root, provider === 'claude' ? `${id}.jsonl` : `rollout-${id}.jsonl`), body)
  const locator = { harness: provider, providerSessionId: id, roots: [root] }
  const source = provider === 'claude' ? createClaudeJsonlSource(locator, { readMode: 'snapshot' }) : createCodexJsonlSource(locator, { readMode: 'snapshot' })
  const timeline = await createSessionTimeline(source, { sessionId: 'captured-provider' })
  try {
    const snapshot = timeline.getSnapshot()
    expect(snapshot.turns.at(-1)?.outcome?.kind).toBe('done')
    expect(deriveAttention(applySnapshot(emptyAgentWatchTimeline(), snapshot))).toBe('done')
    expect(canReleasePhoneInput(true, false, false, snapshot.turns)).toBe(true)
  } finally { timeline.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('does not invent a Claude completion when the final record has no stop_reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provider-no-boundary-1703-'))
  const body = await readFile(new URL('../../../packages/session-core/src/session-record/__fixtures__/claude-final-fragments.jsonl', import.meta.url), 'utf8')
  const rows = body.trim().split('\n').map(line => {
    const row = JSON.parse(line)
    if (row.message) delete row.message.stop_reason
    return JSON.stringify(row)
  })
  await writeFile(join(root, 'claude-final-fragments.jsonl'), rows.join('\n') + '\n')
  const timeline = await createSessionTimeline(createClaudeJsonlSource({ harness: 'claude', providerSessionId: 'claude-final-fragments', roots: [root] },
    { readMode: 'snapshot' }), { sessionId: 'without-provider-end' })
  try {
    const snapshot = timeline.getSnapshot()
    expect(snapshot.turns.at(-1)?.outcome).toBeUndefined()
    expect(deriveAttention(applySnapshot(emptyAgentWatchTimeline(), snapshot))).toBe('running')
    expect(canReleasePhoneInput(true, false, false, snapshot.turns)).toBe(false)
  } finally { timeline.dispose(); await rm(root, { recursive: true, force: true }) }
})
