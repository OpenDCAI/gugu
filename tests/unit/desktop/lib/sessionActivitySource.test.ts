import { expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp'
vi.mock('../../../../apps/desktop/electron/session/main/core/acp/controller', () => ({ peekAcpRuntimeClient: vi.fn() }))
import { activitySourceOf, activityInputOf, currentAssistantWorkInput } from '../../../../apps/desktop/electron/session/main/core/sessions/session-activity-source'
const message = 'ee1a78d8-55f3-42ac-b437-4cf4e81a4741'
const href = `gugu-chat://127ec4f0-30b1-4583-b469-706756153bdd/${message}`
function turn(): TranscriptTurn { return { id: 't', seq: 1, initiator: 'user', items: [{ kind: 'message', id: 'input', seq: 0, role: 'user', text: `<gugu_delivery route="chat" msg="msg:${message}" chat="213036" source_link="${href}"><![CDATA[Do this as a task]]></gugu_delivery>` }] } }
it('uses only the live canonical link of this exact input', () => {
  expect(activitySourceOf(turn())).toBe(href)
  const stale = turn(); stale.outcome = { kind: 'done' }; expect(activitySourceOf(stale)).toBeUndefined()
  const changed = turn(); const input = changed.items[0]; if (input.kind !== 'message') throw Error('fixture')
  input.text = input.text.replace(href, href.replace(message, '6417511d-8f36-4cbc-8cbb-81ce9f97df73'))
  expect(activitySourceOf(changed)).toBeUndefined()
})
it('does not guess from a schedule, unrelated input or a turn with several inputs', () => {
  const scheduled = turn(); const input = scheduled.items[0]; if (input.kind !== 'message') throw Error('fixture')
  input.text = input.text.replace('route="chat"', 'route="scheduled"'); expect(activitySourceOf(scheduled)).toBeUndefined()
  const mixed = turn(); mixed.items.push({ kind: 'message', id: 'other', seq: 2, role: 'user', text: 'what about the old task?' }); expect(activitySourceOf(mixed)).toBeUndefined()
  expect(activitySourceOf(null)).toBeUndefined()
})

it('extracts a bounded original requirement without the envelope or a later tool prompt', () => {
  expect(activityInputOf(turn())).toEqual({ source_link: href, source_message_id: message, source_summary: 'Do this as a task' })
  const long = turn(); const input = long.items[0]; if (input.kind !== 'message') throw Error('fixture')
  input.text = input.text.replace('Do this as a task', '读一下 🍵'.repeat(100))
  const source = activityInputOf(long)!
  expect(Array.from(source.source_summary)).toHaveLength(201)
  expect(source.source_summary).toMatch(/…$/)
  expect(source.source_summary).not.toContain('gugu_delivery')
  long.outcome = { kind: 'done' }
  expect(activityInputOf(long)).toBeUndefined()
})

// Reused sessions must bind a report to this live turn, never a cached previous task.
it('reads only the one still-active task input', () => {
  const active=turn(); const input=active.items[0]; if(input.kind!=='message')throw Error('fixture')
  expect(currentAssistantWorkInput(active)).toBe(input.text)
  active.items.push({kind:'message',id:'reply',seq:1,role:'assistant',text:'working'})
  expect(currentAssistantWorkInput(active)).toBe(input.text)
  active.outcome={kind:'done'}; expect(currentAssistantWorkInput(active)).toBeUndefined()
  delete active.outcome; active.endedAt=1; expect(currentAssistantWorkInput(active)).toBeUndefined()
  delete active.endedAt; active.items.push({kind:'message',id:'later',seq:2,role:'user',text:'a different task'})
  expect(currentAssistantWorkInput(active)).toBeUndefined()
})

it('a session the ACP runtime does not hold (pty) has no work input; a stalled runtime fails instead of hanging', async () => {
  const { peekAcpRuntimeClient } = await import('../../../../apps/desktop/electron/session/main/core/acp/controller')
  const { readCurrentAssistantWorkInput } = await import('../../../../apps/desktop/electron/session/main/core/sessions/session-activity-source')
  const detach = vi.fn()
  const source = (snapshot: () => Promise<unknown>) => ({ session: { state: () => ({
    topic: 'activeTurn', snapshot, attach: async () => detach,
  }) } })
  const notFound = Object.assign(new Error("Unknown live topic 'activeTurn' (no instance for this key)"), { code: 'NOT_FOUND' })
  vi.mocked(peekAcpRuntimeClient).mockResolvedValue(source(async () => { throw notFound }) as never)
  await expect(readCurrentAssistantWorkInput('pty-session')).resolves.toBeUndefined()
  vi.mocked(peekAcpRuntimeClient).mockResolvedValue(source(() => new Promise(() => {})) as never)
  await expect(readCurrentAssistantWorkInput('stalled', 20)).rejects.toThrow(/could not be read within 20ms/)
  vi.mocked(peekAcpRuntimeClient).mockResolvedValue(source(async () => { throw Object.assign(new Error('runtime crashed'), { code: 'DISCONNECTED' }) }) as never)
  await expect(readCurrentAssistantWorkInput('crashed')).rejects.toThrow('runtime crashed')
})
