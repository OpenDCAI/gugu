import { describe, expect, it } from 'vitest'
import { historyFloor, visibleTo } from './visibleTo'
import parity from './visibleTo.parity.json'
import type { SearchActorScope, SearchDocument, SearchDocumentAccess } from './types'

const document: SearchDocument = {
  id: 'message', chatId: 'group', threadRootId: null, seq: 1, senderId: 'peer',
  createdAt: '2026-10-20T12:00:00Z', text: 'visible', isWhisper: false,
  toUserIds: [], deletedAt: null, hasFile: false, hasImage: false, hasLink: false,
}
const scope: SearchActorScope = { actorId: 'owner', chatId: 'group', floor: { known: true, at: null } }
const access: SearchDocumentAccess = { actorId: 'owner', messageId: 'message', fromHistory: false, hiddenForActor: false }

describe('actor visibility', () => {
  it.each(parity.cases)('agrees with the shared backend scenario: $name', (cell) => {
    const memberships = cell.memberships.map((row) => ({
      ...row, floor: { known: true as const, at: row.floor.at },
    }))
    const scope = historyFloor(cell.document.chatId, cell.sourceChatId, cell.actorId, memberships)
    expect(visibleTo(cell.document, cell.actorId, scope, cell.access)).toBe(cell.searchVisible)
  })

  it('uses the earlier direct/topic-source floor, including unrestricted membership', () => {
    const rows = [
      { actorId: 'owner', chatId: 'group', floor: { known: true as const, at: '2026-10-20T10:00:00Z' } },
      { actorId: 'owner', chatId: 'topic', floor: { known: true as const, at: '2026-10-20T11:00:00Z' } },
    ]
    expect(historyFloor('topic', 'group', 'owner', rows)?.floor).toEqual(rows[0].floor)
    expect(historyFloor('topic', 'group', 'owner', [{ ...rows[0], floor: { known: true, at: null } }, rows[1]])?.floor)
      .toEqual({ known: true, at: null })
    expect(historyFloor('group', null, 'outsider', rows)).toBeNull()
    expect(historyFloor('topic', 'group', 'owner', [rows[0], { ...rows[1], floor: { known: false } }])?.floor)
      .toEqual({ known: false })
  })

  it('does not turn another actor, an unknown hide, or a revoked membership into access', () => {
    expect(visibleTo(document, 'owner', scope, access)).toBe(true)
    expect(visibleTo(document, 'agent', scope, access)).toBe(false)
    expect(visibleTo(document, 'owner', scope, { ...access, hiddenForActor: null })).toBe(false)
    expect(visibleTo(document, 'owner', scope, { ...access, hiddenForActor: true })).toBe(false)
    expect(visibleTo(document, 'owner', null, { ...access, fromHistory: true })).toBe(false)
    expect(visibleTo({ ...document, deletedAt: document.createdAt }, 'owner', scope, access)).toBe(false)
  })

  it('allows unknown floors only with the exact actor history proof and still checks whisper recipients', () => {
    const unknown: SearchActorScope = { ...scope, floor: { known: false } }
    expect(visibleTo(document, 'owner', unknown, access)).toBe(false)
    expect(visibleTo(document, 'owner', unknown, { ...access, fromHistory: true })).toBe(true)
    const whisper = { ...document, isWhisper: true, toUserIds: ['agent'] }
    expect(visibleTo(whisper, 'owner', unknown, { ...access, fromHistory: true })).toBe(false)
    expect(visibleTo({ ...whisper, senderId: 'owner' }, 'owner', unknown, { ...access, fromHistory: true })).toBe(true)
  })

  it('keeps the floor inclusive and compares timestamp instants rather than offsets', () => {
    const at = { ...scope, floor: { known: true as const, at: '2026-10-20T14:00:00+02:00' } }
    expect(visibleTo(document, 'owner', at, access)).toBe(true)
    expect(visibleTo({ ...document, createdAt: '2026-10-20T11:59:59.999Z' }, 'owner', at, access)).toBe(false)
  })
})
