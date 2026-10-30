import { describe, expect, it } from 'vitest'
import { dmRecord, dmRecordIds, mergeDmRecord } from '../../../../apps/desktop/src/components/chat/agent-dm-record'
import { message } from '../../../support/testHarness'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'

const names = { me: { display_name: 'Me' }, agent: { display_name: 'Agent' } }
const human = (id: string, seq: number) => message({ id, seq, chat_id: 'dm', sender_user_id: 'me', is_mine: true, content: 'OK' })

describe('authorized DM rows in the shared transcript', () => {
  it('keeps an external agent reply readable without access to its session', () => {
    const rows = dmRecord([human('m1', 1), message({ id: 'm2', seq: 2, sender_user_id: 'agent', is_mine: false, content: 'Reply' })], names)
    expect(rows.map(row => row.items[0].kind === 'message' ? row.items[0].role : '')).toEqual(['user', 'assistant'])
    expect(rows[1].items[0]).toMatchObject({ text: 'Reply' })
    expect(rows.flatMap(row => row.items).every(item => item.kind === 'message')).toBe(true)
    const input = rows[0].items[0]
    expect(input.kind === 'message' && readDeliveryEnvelope(input.text)?.body).toBe('OK')
  })

  it('does not deduplicate repeated words and merges only by real message provenance', () => {
    const rows = [human('m1', 1), human('m2', 2)]
    const recorded = dmRecord(rows.slice(0, 1), names)
    expect(dmRecordIds(recorded).get('m1')).toEqual(['m1'])
    const merged = mergeDmRecord(recorded, rows, names)
    expect(merged).toHaveLength(2)
    expect(merged.map(row => row.items[0].id)).toEqual(['m1', 'm2'])
    expect(mergeDmRecord(merged, rows, names)).toHaveLength(2)
  })

  it('retains every message identity in a batched delivery for deduplication and read visibility', () => {
    const rows = dmRecord([human('m1', 1), human('m2', 2)], names)
    const items = rows.flatMap(row => row.items)
    const batch = [{ ...rows[0], items: [{ ...items[0], id: 'batch', text: items.map(item => item.kind === 'message' ? item.text : '').join('\n') }] }] as TranscriptTurn[]
    expect(dmRecordIds(batch).get('batch')).toEqual(['m1', 'm2'])
    expect(dmRecordIds(batch).get('m1')).toEqual(['m1'])
    expect(dmRecordIds(batch).get('batch:batch-0')).toEqual(['m1'])
    expect(dmRecordIds(batch).get('batch:batch-1')).toEqual(['m2'])
    expect(mergeDmRecord(batch, [human('m1', 1), human('m2', 2)], names)).toBe(batch)
  })

  it('does not append old IM history behind a newer session page', () => {
    const rows = [human('older', 1), human('current', 2)]
    const recent = dmRecord(rows.slice(1), names)
    expect(mergeDmRecord(recent, rows, names)).toBe(recent)
  })

  it('keeps every explicit reply target without an adjacency filter', () => {
    const first = human('m1', 1), second = human('m2', 2)
    const reply = (id: string, quoted: string) => message({ id, seq: 3, sender_user_id: 'agent', is_mine: false,
      reply_to_message_id: quoted, reply_to_sender_user_id: 'me', reply_to_content: 'OK', content: 'Reply' })
    expect(dmRecord([first, second, reply('r1', 'm1')], names).at(-1)?.items[0]).toMatchObject({ sentReplyTo: 'm1', conversationReply: { from: 'Me', text: 'OK' } })
    expect(dmRecord([first, second, reply('r2', 'm2')], names).at(-1)?.items[0]).toHaveProperty('sentReplyTo', 'm2')
  })

  it('keeps system notices separate from the agent voice', () => {
    const rows: TranscriptTurn[] = dmRecord([message({ content_type: 'system', content: 'A recorded system event' })], names)
    expect(rows[0].items[0]).toMatchObject({ kind: 'session-notice', detail: 'A recorded system event' })
  })

  it('adapts IM turns into the session sequence space without changing message seq or identity', () => {
    const recorded = [{ ...dmRecord([human('recorded', 3)], names)[0], seq: 950 }]
    const rows = [human('recorded', 3), human('new', 4), { ...human('pending', -1), local_send_state: 'sending' as const }]
    const merged = mergeDmRecord(recorded, rows, names)
    expect(merged.map(turn => turn.seq)).toEqual([950, 951, 952])
    expect(merged.slice(1).map(turn => [turn.id, turn.items[0].seq])).toEqual([['im:new', 4], ['im:pending', -1]])
    expect(mergeDmRecord(merged, rows, names)).toBe(merged)
  })
})

it('retains text, attachment and text in receipt order, exactly once, even below the later text watermark', async () => {
  const { withSentReplies } = await import('../../../../packages/session-chat-ui/src/state/sent-replies')
  const ids = ['6417511d-8f36-4cbc-8cbb-81ce9f97df71', '6417511d-8f36-4cbc-8cbb-81ce9f97df72', '6417511d-8f36-4cbc-8cbb-81ce9f97df73']
  const calls = ids.map((id, seq) => ({ kind: 'mcp-tool-call' as const, id: `call-${seq}`, toolCallId: `call-${seq}`, seq,
    title: 'Send', server: 'plugin_gugu-product_gugu', status: 'done' as const,
    tool: seq === 1 ? 'message_send_file' : 'message_send',
    rawInput: JSON.stringify(seq === 1 ? { chat_id: 'dm', file: 'existing-file' } : { chat_id: 'dm', text: seq === 0 ? 'First' : 'Last' }),
    outputText: JSON.stringify({ message_id: id }), completedAt: (seq + 1) * 1000,
  }))
  const raw: TranscriptTurn[] = [{ id: 'record', seq: 0, initiator: 'user', items: calls }]
  const rows = ids.map((id, seq) => message({ id, seq: seq + 1, chat_id: 'dm', sender_user_id: 'agent', is_mine: false,
    content_type: seq === 1 ? 'attachment' : 'text', content: seq === 1 ? '[附件] proof.txt (text/plain)\n[Size] 9\n[Kind] file' : seq === 0 ? 'First' : 'Last',
    ...(seq === 1 ? { file_item_id: '7417511d-8f36-4cbc-8cbb-81ce9f97df73', file_version: 2 } : {}),
  }))
  const merged = mergeDmRecord(raw, rows, names)
  const projected = withSentReplies(merged[0], { allDestinations: true })
  const outputs = projected.items.filter(item => item.kind === 'message')
  expect(outputs.map(item => item.kind === 'message' ? item.text : '')).toEqual(['First', 'proof.txt', 'Last'])
  expect((outputs[1] as import('@gugu/session-chat-ui').ChatMessage).sentAttachment).toMatchObject({ messageId: ids[1], href: 'gugu-file://7417511d-8f36-4cbc-8cbb-81ce9f97df73?v=2' })
  expect(withSentReplies(projected, { allDestinations: true }).items).toHaveLength(projected.items.length)
  expect(merged).toHaveLength(1)
  expect(dmRecordIds(merged).get(`call-1:sent:${ids[1]}`)).toEqual([ids[1]])
})
