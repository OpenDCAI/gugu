import { expect, it } from 'vitest'
import { AgentDmReadCursor, dmTranscriptItem } from '../../../../apps/desktop/src/components/chat/agent-dm-read'
import { message } from '../../../support/testHarness'

const rows = Array.from({ length: 8 }, (_, index) => message({ id: `reply-${index + 1}`, seq: index + 1, is_mine: false }))
it('does not read eight accumulated replies when only the last three are visible', () => {
  const cursor = new AgentDmReadCursor(rows[0].id, 0)
  expect(cursor.visible(rows.slice(5).map(row => row.id), rows)).toEqual([])
  expect(cursor.canFollow(rows)).toBe(false)
  expect(cursor.visible([rows[0].id, rows[1].id], rows)).toEqual(rows.slice(0, 2))
  expect(cursor.canFollow(rows)).toBe(false)
  expect(cursor.visible(rows.slice(2, 5).map(row => row.id), rows)).toEqual(rows.slice(2))
  expect(cursor.canFollow(rows)).toBe(true)
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
