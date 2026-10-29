import { beforeEach, describe, expect, it, vi } from 'vitest'

// 每一条查询各记一份它调了什么:要判的是「一条查询里带的 id 有上限」与「只取要的那些行」。
const state = vi.hoisted(() => ({ queries: [] as Array<Array<[string, unknown[]]>>, rows: [] as Array<{ id: string }> }))
vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  makeIdentityClient: () => ({
    from: (...fromArgs: unknown[]) => {
      const calls: Array<[string, unknown[]]> = [['from', fromArgs]]
      state.queries.push(calls)
      const query: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'in']) {
        query[method] = (...args: unknown[]) => {
          calls.push([method, args])
          return query
        }
      }
      query.then = (resolve: (value: unknown) => unknown) => {
        const inCall = calls.find(([method]) => method === 'in')
        const ids = new Set((inCall?.[1][1] as string[] | undefined) ?? [])
        return resolve({ data: state.rows.filter((row) => ids.has(row.id)), error: null })
      }
      return query
    },
  }),
}))

import { IN_FILTER_CHUNK } from '../../../../packages/core/src/shared/inChunks'
import { loadSessionpageCanonicalAgentIdentities } from '../../../../apps/desktop/electron/sessionpage/sessionpage-agent-identity'
import { resolveLocalSessionPeers } from '../../../../apps/desktop/electron/sessionpage/emdash-agent-registry'

const auth = { accessToken: 'token', userId: 'owner-1' }
const agent = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, gugu_number: null, display_name: `Claude ${n}` })

describe('session-page canonical identity lookup', () => {
  beforeEach(() => {
    state.queries = []
    state.rows = []
  })

  // 本机会话上百个时,全部 id 拼进一条 URL 会撞网关上限(实测 100 个 id 即 502),session_peers 整个失败。块的大小是
  // inChunks 的那一个(IN_FILTER_CHUNK),❌ 这里另定一个数(L11 复核 49)。
  it('asks in batches small enough for one URL, each scoped to the owner, and returns every asked identity', async () => {
    state.rows = Array.from({ length: 150 }, (_, i) => agent(i + 1))
    const asked = Array.from({ length: 122 }, (_, i) => agent(i + 1).id)
    const out = await loadSessionpageCanonicalAgentIdentities(auth, asked)
    expect(state.queries).toHaveLength(Math.ceil(122 / IN_FILTER_CHUNK))
    for (const calls of state.queries) {
      const ids = calls.find(([method]) => method === 'in')?.[1][1] as string[]
      expect(ids.length).toBeLessThanOrEqual(IN_FILTER_CHUNK)
      expect(calls).toContainEqual(['eq', ['owner_user_id', 'owner-1']])
      expect(calls).toContainEqual(['eq', ['type', 'agent']])
    }
    expect(out.map((row) => row.id)).toEqual(asked)
  })

  it('never asks for more than the asked ids (no owner-wide read that a row cap could cut short)', async () => {
    state.rows = [agent(1), agent(2), agent(3)]
    expect((await loadSessionpageCanonicalAgentIdentities(auth, [agent(2).id])).map((row) => row.display_name)).toEqual(['Claude 2'])
    expect(state.queries.every((calls) => calls.some(([method]) => method === 'in'))).toBe(true)
  })

  it('asks nothing for an empty list', async () => {
    expect(await loadSessionpageCanonicalAgentIdentities(auth, [])).toEqual([])
    expect(state.queries).toEqual([])
  })

  it('carries the existing archive fact through canonical lookup and native peers without removing the identity', async () => {
    const archivedAt = '2026-10-29T00:00:00Z'
    const archived = { ...agent(1), session_archived_at: archivedAt }
    state.rows = [archived, agent(2)]
    const identities = await loadSessionpageCanonicalAgentIdentities(auth, state.rows.map((row) => row.id))
    const selected = state.queries[0].find(([method]) => method === 'select')?.[1][0] as string
    expect(selected.split(',')).toContain('session_archived_at')
    const bindings = identities.map((identity) => ({ guguAgentUserId: identity.id, sessionId: `task-${identity.id}` }))
    const facts = bindings.map(({ sessionId }) => ({ sessionId, title: 'Existing task', projectName: 'Project',
      status: null, isPinned: false, lastInteractedAt: null }))
    const peers = resolveLocalSessionPeers(bindings, identities, facts)
    expect(peers).toHaveLength(2)
    expect(peers[0].identity.users).toMatchObject({ id: archived.id, session_archived_at: archivedAt })
    expect(peers[1].identity.users).not.toHaveProperty('session_archived_at')
  })
})
