import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestLocalAgent, isolatedGuguEnv } from '../../../support/deviceRuntimeHarness'
import { updateAgent } from '@gugu/core'
import { createSessionpageIdentityHost } from '../../../../apps/desktop/electron/sessionpage/sessionpage-identity-host'

const cloud = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  electronFetch: vi.fn(), makeIdentityClient: () => ({ rpc: cloud.rpc }),
}))

const receipt = { userId: 'old-agent', removedAt: '2026-10-31T03:00:00Z' }
const auth = { accessToken: 'test-token', refreshToken: '', userId: 'owner' }
const host = (env: NodeJS.ProcessEnv) => createSessionpageIdentityHost({
  env, getAuth: async () => auth, resolveDeviceId: async () => 'device',
  resolveProjectName: async () => 'Project', sessionFacts: async () => null, listSessionFacts: async () => [],
})
const bind = (env: NodeJS.ProcessEnv, key: string, id = 'old-agent') => createTestLocalAgent(env,
  { gugu_user_id: id }, { cache: { [key]: 'same-task', sessionpage_owner_user_id: 'owner' } })

beforeEach(() => cloud.rpc.mockReset())

describe('shared identity host archival receipt', () => {
  it.each(['emdash_session_id', 'sessionpage_parked_session_id'])('accepts an existing cloud receipt for its actual %s binding without another write', async key => {
    const env = await isolatedGuguEnv('gugu-archive-receipt-')
    await bind(env, key)
    await expect(host(env).archive('same-task', receipt)).resolves.toEqual(receipt)
    expect(cloud.rpc).not.toHaveBeenCalled()
  })

  it('rejects a stale removed receipt after the same task has a replacement identity', async () => {
    const env = await isolatedGuguEnv('gugu-archive-new-binding-')
    await bind(env, 'emdash_session_id', 'new-agent')
    await expect(host(env).archive('same-task', receipt)).rejects.toThrow('no longer matches')
    expect(cloud.rpc).not.toHaveBeenCalled()
  })

  it('gets and validates a receipt through the same archive RPC for an explicit archive', async () => {
    const env = await isolatedGuguEnv('gugu-archive-cloud-write-')
    await bind(env, 'emdash_session_id')
    cloud.rpc.mockResolvedValueOnce({ data: { user_id: receipt.userId, removed_at: receipt.removedAt, remove_social_identity: true }, error: null })
    await expect(host(env).archive('same-task')).resolves.toEqual(receipt)
    expect(cloud.rpc).toHaveBeenCalledExactlyOnceWith('archive_user', { p_user_id: 'old-agent', p_remove_social_identity: true })
    await updateAgent({ guguUserId: 'old-agent' }, { cache: { emdash_session_id: 'same-task', sessionpage_owner_user_id: 'other-owner' } }, env)
    await expect(host(env).archive('same-task', receipt)).rejects.toThrow('no longer matches')
    expect(cloud.rpc).toHaveBeenCalledTimes(1)
  })
})
