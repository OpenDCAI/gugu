import { expect, it } from 'vitest'
import { AgentDmReadCursor, dmTranscriptItem, visibleDmMessageIds } from '../../../../apps/desktop/src/components/chat/agent-dm-read'
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
  const aliases = new Map([['call:sent:reply-1', ['reply-1']], ['reply-1', ['reply-1']]])
  expect(dmTranscriptItem('reply-1', aliases)).toBe('call:sent:reply-1')
  expect(dmTranscriptItem('missing', aliases)).toBeNull()
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
