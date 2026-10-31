import { expect, it, vi } from 'vitest'
import { createRefreshingRuntimeAuthProvider } from '@gugu/core'

const ticket = (exp: number) => `header.${Buffer.from(JSON.stringify({ sub: 'owner', exp })).toString('base64url')}.sig`
it('refreshes on explicit resume even when a retained local clock considers the ticket valid, sharing the rotation', async () => {
  const refresh = vi.fn(async () => new Response(JSON.stringify({ access_token: ticket(8_000), refresh_token: 'rotated' })))
  const provider = createRefreshingRuntimeAuthProvider({ supabaseUrl: 'https://isolated.invalid', anonKey: 'test',
    accessToken: ticket(4_000), refreshToken: 'original', now: () => 1_000, fetchImpl: refresh })
  await provider.getAuth()
  expect(refresh).not.toHaveBeenCalled()
  const resumed = provider.getAuth({ forceRefresh: true })
  const concurrent = provider.getAuth({ forceRefresh: true })
  await expect(resumed).resolves.toMatchObject({ accessToken: ticket(8_000) })
  await expect(concurrent).resolves.toMatchObject({ accessToken: ticket(8_000) })
  expect(refresh).toHaveBeenCalledOnce()
})

it('does not serve a retained ticket when the explicit refresh is backing off', async () => {
  const refresh = vi.fn(async () => { throw new Error('isolated network unavailable') })
  const provider = createRefreshingRuntimeAuthProvider({ supabaseUrl: 'https://isolated.invalid', anonKey: 'test',
    accessToken: ticket(4_000), refreshToken: 'original', now: () => 1_000, fetchImpl: refresh })
  await expect(provider.getAuth({ forceRefresh: true })).rejects.toThrow('network unavailable')
  await expect(provider.getAuth({ forceRefresh: true })).rejects.toThrow('backing off')
  expect(refresh).toHaveBeenCalledOnce()
})
