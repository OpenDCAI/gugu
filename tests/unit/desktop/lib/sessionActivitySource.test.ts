import { expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp'
vi.mock('../../../../apps/desktop/electron/session/main/core/acp/controller', () => ({ peekAcpRuntimeClient: vi.fn() }))
import { activitySourceOf } from '../../../../apps/desktop/electron/session/main/core/sessions/session-activity-source'
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
