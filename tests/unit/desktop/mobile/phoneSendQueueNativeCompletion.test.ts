import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { SessionInput } from '@/lib/sessionInputOutbox'
import { startPhoneSendQueueObserver } from '@/mobile/agent-watch/phone-send-queue-observer'
import { createSessionTimeline } from '../../../../packages/session-core/src/session-record/timeline'
import { createPiJsonlSource } from '../../../../packages/session-core/src/session-record/sources/pi-jsonl'

it.each([
  ['stop', 'done', 1], ['aborted', 'cancelled', 0], ['error', 'error', 0],
] as const)('handles the actual Pi %s boundary in a held queue outside the task page', async (stopReason, outcome, releases) => {
  const root = await mkdtemp(join(tmpdir(), 'phone-send-queue-native-'))
  const path = join(root, 'session.jsonl')
  const line = (entry: object) => JSON.stringify(entry) + '\n'
  const at = '2026-11-04T06:00:00.000Z'
  await writeFile(path, line({ type: 'session', version: 3, id: 'phone-session', cwd: root, timestamp: at })
    + line({ type: 'message', id: 'u1', parentId: null, timestamp: at, message: { role: 'user', content: '正在处理' } }))
  const timeline = await createSessionTimeline(createPiJsonlSource({ harness: 'pi', providerSessionId: path, roots: [root] }), { sessionId: 'phone-session' })
  let inputs: readonly SessionInput[] = [{ id: 'held-after-native', accountId: 'owner', deviceId: 'phone', sessionId: 'phone-session',
    text: '接着处理', createdAt: 1, queued: true, sendQueue: { order: 1 } }]
  let inputChanged = () => {}, sourceChanged = () => {}
  let reads = 0
  let latest = timeline.getSnapshot({})
  const release = vi.fn(async (_sessionId: string, _turns: readonly TranscriptTurn[], canRelease: () => boolean) => { if (canRelease()) { inputs = []; inputChanged() } })
  const report = vi.fn()
  const stop = startPhoneSendQueueObserver('owner', {
    current: () => true, inputs: () => inputs, available: () => true, retainDirectory: () => () => {},
    subscribe: listener => { inputChanged = listener; return () => {} },
    observe: (_, changed) => {
      sourceChanged = changed
      return { async read() {
        await timeline.catchUp()
        latest = timeline.getSnapshot({})
        reads++
        return { ready: !latest.liveReply && !latest.queuedPrompts?.length, turns: latest.turns }
      }, dispose() {} }
    },
    release, report,
  })
  try {
    await vi.waitFor(() => expect(reads).toBe(1))
    expect(latest.turns.at(-1)?.outcome).toBeUndefined()
    expect(release).not.toHaveBeenCalled()
    await appendFile(path, line({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-11-04T06:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '本轮结束' }], stopReason } }))
    sourceChanged()
    await vi.waitFor(() => expect(reads).toBe(2))
    expect(latest.turns.at(-1)?.outcome?.kind).toBe(outcome)
    expect(release).toHaveBeenCalledTimes(releases)
    expect(report).not.toHaveBeenCalled()
  } finally { stop(); timeline.dispose(); await rm(root, { recursive: true, force: true }) }
})
