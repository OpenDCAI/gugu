// @vitest-environment jsdom
import { act, createElement } from 'react'
import type { User } from '@supabase/supabase-js'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { AccountLoginMethods } from '../../../../apps/desktop/src/components/settings/AccountLoginMethods'

const state = vi.hoisted(() => ({ user: null as User | null, pending: false, finish: vi.fn(), t: (key: string) => key }))
vi.mock('react-i18next', async original => ({ ...await original<object>(), useTranslation: () => ({ t: state.t }) }))
vi.mock('../../../../apps/desktop/src/i18n/registerSettingsCatalog', () => ({}))
vi.mock('../../../../apps/desktop/src/lib/authErrors', () => ({ userVisibleAuthError: String }))
vi.mock('../../../../apps/desktop/src/lib/accountLinkingAdapter', () => ({
  createAccountLinking: () => ({ read: async () => state.user, dispose: () => {}, hasPendingUnlink: () => state.pending, finishUnlink: state.finish }),
  accountGoogleAvailable: () => true,
  cancelAccountGoogle: async () => {},
}))

let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); harness = undefined; state.pending = false; state.finish.mockClear() })

it.each([
  { providers: ['google'], emailOption: false, googleOption: true },
  { providers: ['email'], emailOption: true, googleOption: false },
  { providers: ['email', 'google'], emailOption: true, googleOption: true },
])('offers only existing identities for re-verification: $providers', async ({ providers, emailOption, googleOption }) => {
  state.user = {
    id: 'alice', email: 'alice@example.test', app_metadata: { provider: 'email' }, user_metadata: {}, aud: 'authenticated', created_at: '',
    identities: providers.map(provider => ({ id: provider, identity_id: provider, user_id: 'alice', provider,
      created_at: '', updated_at: '', identity_data: { email: provider === 'google' ? 'google@example.test' : 'alice@example.test' } })),
  }
  harness = createReactHarness()
  await harness.render(createElement(AccountLoginMethods, { userId: 'alice', onEmailChanged: vi.fn() }))
  const buttons = () => Array.from(harness!.container.querySelectorAll('button'))
  const changeEmail = buttons().find(button => button.textContent === 'loginMethods.changeEmail')!
  await act(async () => { changeEmail.click() })
  expect(buttons().some(button => button.textContent === 'loginMethods.byEmail')).toBe(emailOption)
  expect(buttons().some(button => button.textContent === 'loginMethods.byGoogle')).toBe(googleOption)
  expect(buttons().some(button => button.textContent === 'loginMethods.sendCode')).toBe(emailOption)
  if (!googleOption) {
    harness.cleanup()
    state.pending = true
    harness = createReactHarness()
    await harness.render(createElement(AccountLoginMethods, { userId: 'alice', onEmailChanged: vi.fn() }))
    const retry = buttons().find(button => button.textContent === 'loginMethods.retrySignOut')!
    expect(retry).toBeDefined()
    await act(async () => { retry.click() })
    expect(state.finish).toHaveBeenCalledOnce()
  }
})
