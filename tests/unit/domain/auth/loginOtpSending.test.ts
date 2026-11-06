// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runLoginOtpRequest } from '../../../../apps/desktop/src/lib/loginOtpTransport'
import type { LoginOtpResult } from '../../../../apps/desktop/src/lib/auth'
import { i18n } from '../../../../apps/desktop/src/i18n'
import '../../../../apps/desktop/src/i18n/registerMainCatalog'

const m = vi.hoisted(() => ({ request: vi.fn(), verify: vi.fn(), accept: vi.fn(), google: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/auth', () => ({ authService: { requestLoginOtp: m.request, verifyLoginOtp: m.verify } }))
vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: { beginInteractiveLogin: () => 1, acceptInteractiveSession: m.accept } }))
vi.mock('../../../../apps/desktop/src/lib/googleLogin', () => ({ googleLogin: {
  available: true, subscribe: () => () => {}, getSnapshot: () => googleState, start: m.google,
} }))
vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://auth.example.test', getSupabaseAnonKey: () => 'public-test-key' }))
vi.mock('../../../../apps/desktop/src/pages/login/AuthBrandMotion', () => ({ AuthBrandMotion: () => null }))
vi.mock('../../../../apps/desktop/src/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }))
const googleState = { phase: 'idle', busy: false }
const { LoginPage } = await import('../../../../apps/desktop/src/pages/LoginPage')
let host: HTMLDivElement, root: Root
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!
const submit = () => host.querySelector<HTMLButtonElement>('form button[type="submit"]')!
function deferred() { let resolve!: (value: LoginOtpResult) => void; const promise = new Promise<LoginOtpResult>(done => { resolve = done }); return { promise, resolve } }
async function input(selector: string, value: string) {
  await act(async () => {
    const element = host.querySelector<HTMLInputElement>(selector)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function send(email = 'one@example.test') {
  await input('input[type="email"]', email)
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}
async function click(label: string) { await act(async () => button(label).click()) }

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  vi.stubGlobal('fetch', async () => Response.json({ external: { google: true } }))
  await i18n.changeLanguage('zh-CN')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(createElement(LoginPage)))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('email OTP code form', () => {
  it('opens immediately, allows typing while sending, and gates both click and form submit until success', async () => {
    const request = deferred(); m.request.mockReturnValue(request.promise)
    await send()
    expect(host.querySelector('input[autocomplete="one-time-code"]')).not.toBeNull()
    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe('正在向 one@example.test 发送验证码…')
    await input('input[autocomplete="one-time-code"]', '123456')
    expect(submit().disabled).toBe(true)
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(m.verify).not.toHaveBeenCalled()
    await act(async () => { request.resolve({ success: true }) })
    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe('验证码已发送至 one@example.test，请查收邮件')
    expect(submit().disabled).toBe(false)
    m.verify.mockResolvedValue({ success: true, session: { access_token: 'test-session' } })
    await act(async () => submit().click())
    expect(m.verify).toHaveBeenCalledWith('one@example.test', '123456')
    expect(m.accept).toHaveBeenCalledWith(1, { access_token: 'test-session' })
  })

  it.each(['网络连接失败，请检查网络后重试。', '发送验证码超时，请重试', '邮箱地址格式不正确', '验证码服务暂时不可用，请稍后重试'])('preserves entered digits and the %s send failure while offering a real retry', async error => {
    const request = deferred(); m.request.mockReturnValueOnce(request.promise)
    await send(); await input('input[autocomplete="one-time-code"]', '123456')
    await act(async () => { request.resolve({ success: false, error }) })
    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe('验证码没发出去（one@example.test）')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(error)
    expect((host.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement).value).toBe('123456')
    await input('input[autocomplete="one-time-code"]', '654321')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(error)
    expect(submit().disabled).toBe(true)
    expect(button('重新发送').disabled).toBe(false)
    const retry = deferred(); m.request.mockReturnValueOnce(retry.promise)
    await click('重新发送')
    expect(m.request).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="status"]')?.textContent).toContain('正在向')
    await act(async () => { retry.resolve({ success: true }) })
    expect(submit().disabled).toBe(false)
  })

  it('keeps a rate-limit countdown, prevents early resends, then retries once after expiry', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
    m.request.mockResolvedValueOnce({ success: false, error: '操作过于频繁，请稍后再试', retryAfterSeconds: 3 })
    await send()
    expect(button('重新发送 (3s)').disabled).toBe(true)
    await click('重新发送 (3s)')
    expect(m.request).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(button('重新发送').disabled).toBe(false)
    const request = deferred(); m.request.mockReturnValueOnce(request.promise)
    await act(async () => { button('重新发送').click(); button('重新发送').click() })
    expect(m.request).toHaveBeenCalledTimes(2)
    await act(async () => { request.resolve({ success: true }) })
    expect(button('重新发送 (60s)').disabled).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(button('重新发送').disabled).toBe(false)
  })

  it('ignores a late old-email failure while a newer email request is pending', async () => {
    const old = deferred(), current = deferred(); m.request.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    await send()
    expect(button('换邮箱').disabled).toBe(false)
    await click('换邮箱'); await send('two@example.test')
    await act(async () => { old.resolve({ success: false, error: 'old mailbox failed' }) })
    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe('正在向 two@example.test 发送验证码…')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    await act(async () => { current.resolve({ success: true }) })
    expect(host.querySelector('[role="status"]')?.textContent).toContain('two@example.test')
  })

  it('does not restore an old code form on a late response after changing email or unmounting', async () => {
    const request = deferred(); m.request.mockReturnValue(request.promise)
    await send(); await click('换邮箱')
    await act(async () => { request.resolve({ success: true }) })
    expect(host.querySelector('input[type="email"]')).not.toBeNull()
    expect(host.querySelector('input[autocomplete="one-time-code"]')).toBeNull()
    const pending = deferred(); m.request.mockReturnValue(pending.promise)
    await send()
    await act(async () => root.unmount()); root = createRoot(host)
    await act(async () => { pending.resolve({ success: false, error: 'late' }); root.render(createElement(LoginPage)) })
    expect(host.querySelector('input[type="email"]')).not.toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('rejects an invalid email locally without making a send request', async () => {
    await send('invalid')
    expect(m.request).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('邮箱地址格式不正确')
    expect(host.querySelector('input[type="email"]')).not.toBeNull()
  })

  it('preserves successful-send cooldown when revisiting the same address', async () => {
    vi.useFakeTimers(); m.request.mockResolvedValue({ success: true })
    await send(); await click('换邮箱'); await send()
    expect(m.request).toHaveBeenCalledOnce()
    expect(button('重新发送 (60s)').disabled).toBe(true)
    expect(submit().disabled).toBe(true)
  })
})


it('keeps Google disabled until a retired OTP operation finishes using its shared PKCE storage', async () => {
  const request = deferred()
  let active!: Promise<LoginOtpResult>
  await act(async () => { active = runLoginOtpRequest('retired@example.test', () => request.promise); await Promise.resolve() })
  expect(button('用 Google 登录').disabled).toBe(true)
  await click('用 Google 登录')
  expect(m.google).not.toHaveBeenCalled()
  await act(async () => { request.resolve({ success: false }); await active })
  expect(button('用 Google 登录').disabled).toBe(false)
  await click('用 Google 登录')
  expect(m.google).toHaveBeenCalledOnce()
})
