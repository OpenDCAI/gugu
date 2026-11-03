// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GoogleLoginState } from '../../../../apps/desktop/src/lib/googleLoginFlow'
import { i18n } from '../../../../apps/desktop/src/i18n'
import '../../../../apps/desktop/src/i18n/registerMainCatalog'

const m = vi.hoisted(() => ({
  state: { phase: 'idle', busy: false } as GoogleLoginState,
  listeners: new Set<() => void>(), start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), requestOtp: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/googleLogin', () => ({ googleLogin: {
  available: true, getSnapshot: () => m.state,
  subscribe: (listener: () => void) => { m.listeners.add(listener); return () => m.listeners.delete(listener) },
  start: m.start, cancel: m.cancel,
} }))
vi.mock('../../../../apps/desktop/src/lib/auth', () => ({ authService: { requestLoginOtp: m.requestOtp } }))
vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: {} }))
vi.mock('../../../../apps/desktop/src/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }))
const { LoginPage } = await import('../../../../apps/desktop/src/pages/LoginPage')
let root: Root, host: HTMLDivElement
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === label)!
async function state(value: GoogleLoginState) { await act(async () => { m.state = value; for (const listener of m.listeners) listener() }) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  m.state = { phase: 'idle', busy: false }
  await i18n.changeLanguage('zh-CN')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<LoginPage />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

it('starts Google with one minimal button and exposes explicit cancellation while authorization is pending', async () => {
  expect(button('用 Google 登录')).toBeDefined()
  await act(async () => button('用 Google 登录').click())
  expect(m.start).toHaveBeenCalledOnce()
  await state({ phase: 'authorizing', busy: true })
  expect(host.querySelector('[role="status"]')?.textContent).toBe('请在浏览器中完成 Google 登录')
  await act(async () => button('取消 Google 登录').click())
  expect(m.cancel).toHaveBeenCalledOnce()
  await state({ phase: 'accepting', busy: true })
  expect(button('取消 Google 登录').disabled).toBe(true)
})

it.each([
  ['cancelled', '已取消 Google 登录'], ['timeout', 'Google 登录已超时，请重试'],
  ['invalidCode', '登录授权已过期或与本次登录不匹配，请重试'],
] as const)('shows the real %s failure and enables a fresh attempt', async (failure, copy) => {
  await state({ phase: 'failed', failure, busy: false })
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy)
  expect(button('用 Google 登录').disabled).toBe(false)
})

it('does not let email submission overwrite an active Google verifier', async () => {
  const input = host.querySelector<HTMLInputElement>('input[type="email"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'verified@example.test')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!
  expect(submit.disabled).toBe(false) // Positive control: the filled email can submit when Google is idle.
  await state({ phase: 'authorizing', busy: true })
  expect(submit.disabled).toBe(true)
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(m.requestOtp).not.toHaveBeenCalled()
})
