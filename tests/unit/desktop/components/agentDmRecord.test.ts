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
    expect(dmRecordIds(recorded).get('m1')).toBe('m1')
    const merged = mergeDmRecord(recorded, rows, names)
    expect(merged).toHaveLength(2)
    expect(merged.map(row => row.items[0].id)).toEqual(['m1', 'm2'])
    expect(mergeDmRecord(merged, rows, names)).toHaveLength(2)
  })

  it('does not append old IM history behind a newer session page', () => {
    const rows = [human('older', 1), human('current', 2)]
    const recent = dmRecord(rows.slice(1), names)
    expect(mergeDmRecord(recent, rows, names)).toBe(recent)
  })

  it('keeps an explicit older-message quote but hides a quote to the peer latest message', () => {
    const first = human('m1', 1), second = human('m2', 2)
    const reply = (id: string, quoted: string) => message({ id, seq: 3, sender_user_id: 'agent', is_mine: false,
      reply_to_message_id: quoted, reply_to_sender_user_id: 'me', reply_to_content: 'OK', content: 'Reply' })
    expect(dmRecord([first, second, reply('r1', 'm1')], names).at(-1)?.items[0]).toMatchObject({ sentReplyTo: 'm1', conversationReply: { from: 'Me', text: 'OK' } })
    expect(dmRecord([first, second, reply('r2', 'm2')], names).at(-1)?.items[0]).not.toHaveProperty('sentReplyTo')
  })

  it('keeps system notices separate from the agent voice', () => {
    const rows: TranscriptTurn[] = dmRecord([message({ content_type: 'system', content: 'A recorded system event' })], names)
    expect(rows[0].items[0]).toMatchObject({ kind: 'session-notice', detail: 'A recorded system event' })
  })
})
