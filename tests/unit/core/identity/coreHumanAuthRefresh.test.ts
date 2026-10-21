import { describe, expect, test } from 'vitest'
import {
  readFreshHumanAuthSession,
  readHumanAuthSession,
  refreshSupabaseSession,
  RuntimeAuthExpiredError,
  writeHumanAuthSession,
  type HumanAuthRefreshOwner
} from '@gugu/core'
import { isolatedGuguEnv } from '../../../support/deviceRuntimeHarness'

function jwt(sub: string, exp: number): string {
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')
  return `header.${payload}.sig`
}

async function seedSession(
  env: NodeJS.ProcessEnv,
  refresh_owner: HumanAuthRefreshOwner,
  accessToken: string
): Promise<void> {
  await writeHumanAuthSession(
    {
      user_id: 'owner-1',
      email: 'owner@example.test',
      access_token: accessToken,
      refresh_token: 'refresh-1',
      refresh_owner,
      updated_at: '2026-06-04T00:00:00.000Z'
    },
    env
  )
}

const REFRESH_DEPS = {
  supabaseUrl: 'https://supabase.example.test/',
  anonKey: 'anon-key',
  now: () => 1_000
}

describe('readFreshHumanAuthSession', () => {
  test('returns null when no session is stored', async () => {
    const env = await isolatedGuguEnv('gugu-human-refresh-')
    await expect(readFreshHumanAuthSession(env, REFRESH_DEPS)).resolves.toBeNull()
  })

  test('cli-owned: refreshes a near-expired token, rotates the chain, and persists', async () => {
    const env = await isolatedGuguEnv('gugu-human-refresh-')
    await seedSession(env, 'cli', jwt('owner-1', 100)) // exp 100 < now 1000 → stale

    const seen: string[] = []
    const fresh = await readFreshHumanAuthSession(env, {
      ...REFRESH_DEPS,
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(String(init.body)).refresh_token)
        return new Response(
          JSON.stringify({ access_token: jwt('owner-1', 5_000), refresh_token: 'refresh-2' }),
          { status: 200 }
        )
      }
    })

    expect(seen).toEqual(['refresh-1'])
    expect(fresh?.access_token).toBe(jwt('owner-1', 5_000))
    expect(fresh?.refresh_token).toBe('refresh-2')

    // Persisted: the next read resumes from the rotated pair.
    const persisted = await readHumanAuthSession(env)
    expect(persisted?.access_token).toBe(jwt('owner-1', 5_000))
    expect(persisted?.refresh_token).toBe('refresh-2')
  })

  test('cli-owned: does not refresh while the token is still valid', async () => {
    const env = await isolatedGuguEnv('gugu-human-refresh-')
    await seedSession(env, 'cli', jwt('owner-1', 10_000)) // far in the future

    let calls = 0
    const fresh = await readFreshHumanAuthSession(env, {
      ...REFRESH_DEPS,
      fetchImpl: async () => {
        calls += 1
        return new Response('{}', { status: 200 })
      }
    })

    expect(calls).toBe(0)
    expect(fresh?.refresh_token).toBe('refresh-1')
  })

  test('desktop-owned: never refreshes, even when expired (the renderer owns the chain)', async () => {
    const env = await isolatedGuguEnv('gugu-human-refresh-')
    await seedSession(env, 'desktop', jwt('owner-1', 100)) // stale

    let calls = 0
    const fresh = await readFreshHumanAuthSession(env, {
      ...REFRESH_DEPS,
      fetchImpl: async () => {
        calls += 1
        return new Response('{}', { status: 200 })
      }
    })

    expect(calls).toBe(0)
    expect(fresh?.access_token).toBe(jwt('owner-1', 100))
    expect(fresh?.refresh_token).toBe('refresh-1')
  })
})

describe('refreshSupabaseSession', () => {
  test('returns the rotated access/refresh pair on success', async () => {
    const result = await refreshSupabaseSession({
      supabaseUrl: 'https://supabase.example.test/',
      anonKey: 'anon-key',
      refreshToken: 'refresh-1',
      fetchImpl: async (url, init) => {
        expect(url).toBe('https://supabase.example.test/auth/v1/token?grant_type=refresh_token')
        expect(JSON.parse(String(init.body)).refresh_token).toBe('refresh-1')
        return new Response(
          JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2' }),
          { status: 200 }
        )
      }
    })
    expect(result).toEqual({ accessToken: 'access-2', refreshToken: 'refresh-2' })
  })

  test('fails loudly when the refresh endpoint rejects the token', async () => {
    // A 400 is PERMANENT loss (#484): the refresh token itself was rejected.
    await expect(
      refreshSupabaseSession({
        supabaseUrl: 'https://supabase.example.test',
        anonKey: 'anon-key',
        refreshToken: 'stale',
        fetchImpl: async () => new Response('{"error":"invalid_grant"}', { status: 400 })
      })
    ).rejects.toBeInstanceOf(RuntimeAuthExpiredError)
  })
})
