// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import type { Root } from 'react-dom/client'
import type { Session } from '@supabase/supabase-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderEntryRoot } from '@/lib/renderer-entry-root'
import { publishSelfIdentity } from '@/lib/selfIdentityBridge'
import { publishRendererSession } from '@/lib/sessionPublication'
import { useAuth } from '@/store/auth'
import { ConversationCreditNotice } from '@/components/chat/ConversationCreditNotice'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Only the WebSocket transport is replaced. The real spending subscription, HTTP
// clients, balance/quota readers and spending derivation stay on the entry path.
vi.mock('@/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: vi.fn((userId, eventName) => ({ userId, eventName, listenerId: 1 })),
  unsubscribePrivateUserEventBus: vi.fn(),
}))

const wallet = new Map([['account-a', 0.999], ['account-b', 0.5]])
const sent: { path: string; authorization: string | null }[] = []
let container: HTMLDivElement
let root: Root | undefined
function signedIn(userId: string) {
  publishRendererSession('SIGNED_IN', { access_token: `entry-token-${userId}`, user: { id: userId } } as Session)
  publishSelfIdentity({ userId, displayName: userId, guguNumber: null })
}
function AuthProbe() {
  return <output data-auth-context="">{useAuth().user?.id ?? 'no-provider'}</output>
}
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  sent.length = 0
  publishSelfIdentity(null)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const authorization = new Headers(init?.headers).get('Authorization')
    sent.push({ path: url.pathname, authorization })
    const userId = authorization?.replace('Bearer entry-token-', '') ?? ''
    let data: unknown
    if (url.pathname === '/rest/v1/user_credits') data = { balance_credits: wallet.get(userId) }
    else if (url.pathname === '/rest/v1/rpc/current_quota_windows') data = [{ plan_id: 'default', period_credits: 0, period_used: 0,
      period_started_at: '2026-11-01T00:00:00Z', period_ends_at: '2026-12-01T00:00:00Z', outstanding_credits: 0, credits_per_usd: 1 }]
    else throw Error(`Unexpected entry request: ${url.pathname}`)
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})
afterEach(() => {
  act(() => { root?.unmount(); publishSelfIdentity(null); publishRendererSession('SIGNED_OUT', null) })
  root = undefined
  container.remove()
  vi.unstubAllGlobals()
})

it('reads authenticated balance in the independent session entry without an AuthProvider or a replaced spending hook', async () => {
  signedIn('account-a')
  await act(async () => {
    root = renderEntryRoot('session-embedded', container, createElement(Fragment, null,
      createElement(AuthProbe), createElement(ConversationCreditNotice, { modelOptionId: 'platform:test' })))
  })
  await settle()
  expect(container.querySelector('[data-auth-context]')?.textContent).toBe('no-provider')
  expect(container.querySelector('[role="status"]')?.textContent).toBe('剩 1 积分 · 充值')
  expect(sent).toEqual(expect.arrayContaining([
    { path: '/rest/v1/user_credits', authorization: 'Bearer entry-token-account-a' },
    { path: '/rest/v1/rpc/current_quota_windows', authorization: 'Bearer entry-token-account-a' },
  ]))

  await act(async () => { signedIn('account-b') })
  await settle()
  expect(container.querySelector('[role="status"]')?.textContent).toBe('剩 0.5 积分 · 充值')
  expect(sent.filter(request => request.authorization === 'Bearer entry-token-account-b')).toHaveLength(2)

  await act(async () => { publishRendererSession('SIGNED_OUT', null); publishSelfIdentity(null) })
  expect(container.querySelector('[role="status"]')).toBeNull()
})
