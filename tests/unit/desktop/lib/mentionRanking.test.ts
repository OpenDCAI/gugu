import { describe, expect, it } from 'vitest'
import type { MentionCandidate } from '../../../../apps/desktop/src/lib/mention'
import { rankMentionCandidates } from '../../../../apps/desktop/src/lib/mentionRanking'

const DAY = 86_400_000
const now = Date.UTC(2026, 9, 25, 12)
const candidate = (id: string, type: MentionCandidate['type'] = 'human'): MentionCandidate => ({ id, name: id, type })
type Context = Parameters<typeof rankMentionCandidates>[2]
type HistoryMessage = Context['messages'][number]
const message = (sender: string, age = 0, overrides: Partial<HistoryMessage> = {}): HistoryMessage => ({
  id: `${sender}-${age}`, chat_id: 'group', sender_user_id: sender, created_at: new Date(now - age).toISOString(),
  to_user_ids: null, reply_to_message_id: null, content_type: 'text', seq: 1, retracted_at: null, ...overrides,
})
const context = (overrides: Partial<Context> = {}): Context => ({ chatId: 'group', currentUserId: 'me', messages: [], now, ...overrides })
const names = (members: readonly MentionCandidate[], messages: readonly HistoryMessage[], query = '', extra: Partial<Context> = {}) =>
  rankMentionCandidates(members, query, context({ messages, ...extra })).map((member) => member.name)

describe('contextual mention ranking', () => {
  it('ranks recent directed interactions and speakers within the addressable roster', () => {
    const members = [candidate('所有人', 'all'), candidate('Alice'), candidate('Aaron'), candidate('Bob'), candidate('Atlas', 'agent'), candidate('Ada', 'agent')]
    const history = [message('Bob', 120_000), message('Atlas', 600_000), message('Ada', DAY / 12), message('Aaron', 3 * DAY),
      message('me', 300_000, { to_user_ids: ['Atlas'] }), message('me', DAY, { reply_to_sender_user_id: 'Ada' }), message('not-a-member')]
    expect(names(members, history)).toEqual(['Atlas', 'Ada', 'Bob', 'Aaron', 'Alice', '所有人'])
    expect(names(members, history, 'a')).toEqual(['Atlas', 'Ada', 'Aaron', 'Alice'])
  })

  it('keeps text quality ahead of contextual relevance and preserves existing matching', () => {
    const members = [candidate('Aaron'), candidate('a'), { ...candidate('张三丰'), alias: 'Alice', guguNumber: 10086 }, candidate('Team Aaron')]
    const history = [message('Team Aaron'), message('me', 0, { to_user_ids: ['Aaron'] })]
    expect(names(members, history, 'a')).toEqual(['a', 'Aaron', '张三丰', 'Team Aaron'])
    expect(names(members, history, 'ALICE')).toEqual(['张三丰'])
    expect(names(members, history, 'zsf')).toEqual(['张三丰'])
    expect(names(members, history, '100')).toEqual(['张三丰'])
    expect(names(members, history, 'nobody')).toEqual([])
  })

  it('keeps an exact broadcast match above a less precise person match', () => {
    expect(names([candidate('Allison'), candidate('all', 'all')], [message('Allison')], 'all')).toEqual(['all', 'Allison'])
  })

  it('keeps topic participants ahead of invitees within each text tier', () => {
    const members = [candidate('Aaron'), candidate('Alice'), candidate('Ada')]
    expect(names(members, [message('Aaron')], 'a', { participantIds: ['Ada', 'Alice'] })).toEqual(['Alice', 'Ada', 'Aaron'])
    expect(names(members, [message('Aaron')], 'Aaron', { participantIds: ['Ada'] })).toEqual(['Aaron'])
  })

  it('prefers the current reply author only when they match and does not guess from names', () => {
    const members = [candidate('Alice'), candidate('Bob')]
    const history = [message('Bob', DAY, { id: 'quoted' }), message('Alice')]
    expect(names(members, history, '', { replyToMessageId: 'quoted' })).toEqual(['Bob', 'Alice'])
    expect(names(members, history, 'a', { replyToMessageId: 'quoted' })).toEqual(['Alice'])
    expect(names(members, history, '', { replyToMessageId: 'not-loaded' })).toEqual(['Alice', 'Bob'])
  })

  it('uses the reply author field or the loaded reply target without depending on row order', () => {
    const members = [candidate('Alice'), candidate('Bob')]
    const reply = message('me', 0, { reply_to_message_id: 'old', reply_to_sender_user_id: undefined })
    expect(names(members, [reply, message('Bob', DAY, { id: 'old' }), message('Alice')])).toEqual(['Bob', 'Alice'])
    expect(names(members, [message('Alice'), { ...reply, reply_to_sender_user_id: 'Bob' }])).toEqual(['Bob', 'Alice'])
    expect(names(members, [message('Alice'), reply])).toEqual(['Alice', 'Bob'])
  })

  it('applies seven-day interaction and one-day speaker half-lives', () => {
    const members = [candidate('Alice'), candidate('Bob')]
    expect(names(members, [message('me', 7 * DAY, { to_user_ids: ['Bob'] }), message('Alice')])).toEqual(['Alice', 'Bob'])
    expect(names(members, [message('me', 6 * DAY, { to_user_ids: ['Bob'] }), message('Alice')])).toEqual(['Bob', 'Alice'])
    expect(names(members, [message('me', 14 * DAY, { to_user_ids: ['Bob'] }), message('Alice', DAY)])).toEqual(['Alice', 'Bob'])
    expect(names(members, [message('me', 13 * DAY, { to_user_ids: ['Bob'] }), message('Alice', DAY)])).toEqual(['Bob', 'Alice'])
  })

  it('takes only the latest interaction, deduplicates recipients and never accumulates frequency', () => {
    const members = [candidate('Alice'), candidate('Bob')]
    const older = message('me', DAY, { to_user_ids: ['Alice', 'Alice'], reply_to_sender_user_id: 'Alice' })
    expect(names(members, [...Array.from({ length: 20 }, () => older), message('me', 1, { to_user_ids: ['Bob'] })])).toEqual(['Bob', 'Alice'])
    expect(names(members, [message('Bob', DAY), message('Bob', 0), message('Alice', 1)])).toEqual(['Bob', 'Alice'])
  })

  it.each([
    { chat_id: 'another-chat' }, { content_type: 'system' as const }, { retracted_at: new Date(now).toISOString() },
    { seq: -1 }, { local_send_state: 'failed' as const }, { local_send_state: 'sending' as const }, { created_at: 'invalid' },
  ])('ignores ineligible history: %j', (overrides) => {
    expect(names([candidate('Alice'), candidate('Bob')], [message('Bob', 0, overrides)])).toEqual(['Alice', 'Bob'])
  })

  it('counts only the current human author as personal interaction', () => {
    const members = [candidate('Alice'), candidate('Bob')]
    for (const overrides of [{ sender_user_id: 'someone-else' }, { sent_by_agent: true }, { via_app: 'test-app' }]) {
      expect(names(members, [message('me', 0, { to_user_ids: ['Bob'], ...overrides })])).toEqual(['Alice', 'Bob'])
    }
    expect(names(members, [message('me', 0, { to_user_ids: ['*'] })])).toEqual(['Alice', 'Bob'])
    expect(names(members, [message('me', 0, { to_user_ids: ['Bob'] })], '', { currentUserId: null })).toEqual(['Alice', 'Bob'])
  })

  it('treats humans and agents alike, keeps equal scores stable, and does not mutate inputs', () => {
    const members = Object.freeze([Object.freeze(candidate('Alice')), Object.freeze(candidate('Bob', 'agent'))])
    const history = Object.freeze([Object.freeze(message('Bob', -DAY)), Object.freeze(message('Alice'))])
    expect(names(members, history)).toEqual(['Alice', 'Bob'])
    expect(names(members, [], '')).toEqual(['Alice', 'Bob'])
    expect(names([], history)).toEqual([])
  })
})
