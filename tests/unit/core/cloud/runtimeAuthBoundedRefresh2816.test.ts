import { expect, test } from 'vitest'
import {
  createRefreshingRuntimeAuthProvider,
  RuntimeAuthRefreshTimeoutError,
} from '@gugu/core'

function token(sub: string, exp: number): string {
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')
  return `header.${payload}.sig`
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function rotatedResponse(exp: number): Response {
  return new Response(JSON.stringify({
    access_token: token('user-1', exp),
    refresh_token: 'refresh-2',
  }), { status: 200 })
}

test('bounds a stuck additional-account refresh without rejecting a slow valid response', async () => {
  let clock = 1_000
  let mode: 'stuck' | 'valid' = 'stuck'
  let fetchCalls = 0
  let aborts = 0
  const provider = createRefreshingRuntimeAuthProvider({
    supabaseUrl: 'https://supabase.example.test',
    anonKey: 'anon-key',
    accessToken: token('user-1', 100),
    refreshToken: 'refresh-1',
    now: () => clock,
    refreshTimeoutMs: 40,
    backoffBaseMs: 1_000,
    fetchImpl: async (_url, init) => {
      fetchCalls += 1
      if (mode === 'valid') return rotatedResponse(clock + 3_600)
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init.signal
        signal?.addEventListener('abort', () => {
          aborts += 1
          reject(signal.reason)
        }, { once: true })
      })
    },
  })

  const first = provider.getAuth()
  const second = provider.getAuth()
  const stuckResults = await Promise.allSettled([first, second])
  expect(stuckResults).toEqual([
    expect.objectContaining({ status: 'rejected', reason: expect.any(RuntimeAuthRefreshTimeoutError) }),
    expect.objectContaining({ status: 'rejected', reason: expect.any(RuntimeAuthRefreshTimeoutError) }),
  ])
  expect(fetchCalls).toBe(1)
  expect(aborts).toBe(1)

  await expect(provider.getAuth()).rejects.toThrow(/backing off/)
  expect(fetchCalls).toBe(1)

  mode = 'valid'
  clock += 2
  await expect(provider.getAuth()).resolves.toMatchObject({
    userId: 'user-1',
    refreshToken: 'refresh-2',
  })
  expect(fetchCalls).toBe(2)

  let slowCalls = 0
  let slowAborted = false
  const slowProvider = createRefreshingRuntimeAuthProvider({
    supabaseUrl: 'https://supabase.example.test',
    anonKey: 'anon-key',
    accessToken: token('user-1', 100),
    refreshToken: 'refresh-1',
    now: () => 1_000,
    refreshTimeoutMs: 60,
    fetchImpl: async (_url, init) => {
      slowCalls += 1
      init.signal?.addEventListener('abort', () => { slowAborted = true }, { once: true })
      await delay(40)
      return rotatedResponse(4_600)
    },
  })

  await expect(slowProvider.getAuth()).resolves.toMatchObject({
    userId: 'user-1',
    refreshToken: 'refresh-2',
  })
  expect(slowCalls).toBe(1)
  expect(slowAborted).toBe(false)
  console.log(JSON.stringify({
    reading: 'B',
    stuck: { timeoutMs: 40, fetchCalls: 1, aborts, callersRejected: 2 },
    recovery: { backoffMs: 1_000, fetchCalls },
    slowValid: { delayMs: 40, timeoutMs: 60, fetchCalls: slowCalls, aborted: slowAborted },
  }))
})
