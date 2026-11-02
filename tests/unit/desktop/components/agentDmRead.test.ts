import { expect, it } from 'vitest'
import { AgentDmReadCursor, visibleDmMessageIds } from '../../../../apps/desktop/src/components/chat/agent-dm-read'
import { message } from '../../../support/testHarness'

const rows = Array.from({ length: 8 }, (_, index) => message({ id: `reply-${index + 1}`, seq: index + 1, is_mine: false }))
it('does not read eight accumulated replies when only the last three are visible', () => {
  const cursor = new AgentDmReadCursor(rows[0].id, 0)
  expect(cursor.visible(rows.slice(5).map(row => row.id), rows)).toEqual([])
  expect(cursor.canFollow(rows)).toBe(false)
  expect(cursor.visible([rows[0].id, rows[1].id], rows)).toEqual(rows.slice(0, 2))
  expect(cursor.canFollow(rows)).toBe(false)
  cursor.acknowledge(2)
  expect(cursor.visible(rows.slice(2, 5).map(row => row.id), rows)).toEqual(rows.slice(2))
  expect(cursor.canFollow(rows)).toBe(true)
  cursor.acknowledge(8)
  expect(cursor.visible(rows.map(row => row.id), rows)).toEqual([])
})
it('waits for a first unread outside the loaded window and uses only canonical receipt identity', () => {
  const cursor = new AgentDmReadCursor('reply-1', 0)
  expect(cursor.visible(['reply-8'], rows.slice(4))).toEqual([])
  expect(cursor.canFollow(rows.slice(4))).toBe(false)
})

it('does not let a resolved hidden delivery notice block the following visible reply', () => {
  const cursor = new AgentDmReadCursor('resolved-notice', 0)
  cursor.ignore(['resolved-notice'])
  expect(cursor.visible([rows[0].id], rows)).toEqual([rows[0]])
})

it('matches a visible successful send by its authorized receipt despite a replay turn-prefix change', () => {
  const id = 'ab8e401c-3c92-441b-a548-54fef697d941'
  const aliases = new Map([[`session:turn:48:tool:send:sent:${id}`, [id]]])
  const received = message({ id, seq: 94, is_mine: false })
  const canonical = visibleDmMessageIds([`session:turn:s61:tool:send:sent:${id}`], aliases, [received])
  expect(canonical).toEqual([id])
  expect(new AgentDmReadCursor(id, 93).visible(canonical, [received])).toEqual([received])
  expect(visibleDmMessageIds([`session:turn:s61:tool:send:sent:${id}`], aliases, [])).toEqual([])
})

it('skips an unprojected first unread without reporting it visible or blocking later replies', () => {
  const cursor = new AgentDmReadCursor(rows[0].id, 0)
  cursor.ignore([rows[0].id])
  expect(cursor.visible([rows[1].id], rows.slice(0, 2))).toEqual([rows[1]])
})

it('retries visible replies until the store confirms their read watermark', () => {
  const cursor = new AgentDmReadCursor(rows[0].id, 0)
  expect(cursor.visible([rows[0].id], rows)).toEqual([rows[0]])
  // The first callback happened before the chat store began observing it.
  expect(cursor.visible([rows[0].id], rows)).toEqual([rows[0]])
  cursor.acknowledge(1)
  expect(cursor.visible([rows[0].id], rows)).toEqual([])
  expect(cursor.visible([rows[1].id], rows)).toEqual([rows[1]])
})

it('releases the original unseen first unread after another device confirms it read', () => {
  const cursor = new AgentDmReadCursor(rows[0].id, 0)
  expect(cursor.visible([rows[1].id], rows)).toEqual([])
  cursor.acknowledge(1)
  expect(cursor.visible([rows[1].id], rows)).toEqual([rows[1]])
  expect(cursor.visible([rows[3].id], rows)).toEqual([rows[1]])
})

it('uses the captured server sequence when the old first unread is no longer in the loaded window', () => {
  const cursor = new AgentDmReadCursor(rows[0].id, 0, 1)
  expect(cursor.visible([rows[4].id], rows.slice(4))).toEqual([])
  cursor.acknowledge(4)
  expect(cursor.visible([rows[4].id], rows.slice(4))).toEqual([rows[4]])
  expect(cursor.canFollow(rows.slice(4))).toBe(false)
})

it('reads a newly projected receipt after its IM row arrived before the transcript alias', () => {
  const cursor = new AgentDmReadCursor(rows[0].id, 0, 1)
  expect(cursor.visible([rows[0].id], rows.slice(0, 1))).toEqual([rows[0]])
  cursor.acknowledge(1)
  cursor.ignore([rows[1].id])
  expect(cursor.visible([], rows.slice(0, 2))).toEqual([])
  expect(cursor.visible([rows[1].id], rows.slice(0, 3))).toEqual([rows[1]])
  cursor.acknowledge(2)
  expect(cursor.visible([rows[1].id], rows.slice(0, 3))).toEqual([])
  expect(cursor.canFollow(rows.slice(0, 3))).toBe(false)
})

it('reads DM ids off the record: one per batched delivery row, and the agent message_send receipt', async () => {
  const { dmMessageIdsByItem } = await import('../../../../apps/desktop/src/components/chat/agent-dm-read')
  const { renderDeliveryEnvelope } = await import('@gugu/core/local/agent/deliveryEnvelope')
  const envelope = (id: string) => renderDeliveryEnvelope({ route: 'chat', from: 'Me', fromId: 'user:me', fromType: 'human', messageId: `msg:${id}`,
    at: '2026-10-31T00:00:00Z', chat: 'dm', chatKind: 'ai', content: 'OK' })
  const sent = '6417511d-8f36-4cbc-8cbb-81ce9f97df71'
  const turns = [
    { id: 'in', seq: 0, initiator: 'user', items: [{ kind: 'message', id: 'batch', seq: 0, role: 'user', text: `${envelope('m1')}\n${envelope('m2')}` }] },
    { id: 'out', seq: 1, initiator: 'agent', items: [{ kind: 'mcp-tool-call', id: 'call', toolCallId: 'call', seq: 1, title: 'Send', server: 'plugin_gugu-product_gugu',
      status: 'done', tool: 'message_send', rawInput: JSON.stringify({ chat_id: 'dm', text: 'Done' }), outputText: JSON.stringify({ message_id: sent }) }] },
  ] as unknown as import('@gugu/session-core/acp/client').TranscriptTurn[]
  const ids = dmMessageIdsByItem(turns)
  expect(ids.get('batch')).toEqual(['m1', 'm2'])
  expect(ids.get('batch:batch-0')).toEqual(['m1'])
  expect(ids.get('batch:batch-1')).toEqual(['m2'])
  expect(ids.get(`call:sent:${sent}`)).toEqual([sent])
  expect(ids.has('m1')).toBe(false)
})
