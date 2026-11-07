import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { MemberProfileCard, type MemberProfileCardModel } from '@/components/MemberProfileCard'
import { i18n } from '@/i18n'
import '@/i18n/registerContactsCatalog'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'

vi.mock('@/hooks/useAgentDisplayStatus', () => import('../../../../../../../tests/support/agentDisplayStatusTestDouble'))

// Synthetic public fixture: no owner screenshot/profile data.
const member: MemberProfileCardModel = {
  id: 'profile-layout-member', displayName: 'Layout Test', type: 'human', role: 'owner',
  avatar: null, email: `${'long-address-'.repeat(4)}@example.invalid`,
  bio: 'A long profile value that wraps within its own column. '.repeat(3),
  guguNumber: 123456, profileScope: 'group', membership: 'current',
}
let h: ReturnType<typeof createReactHarness>
let previousTheme: string | null
beforeEach(() => {
  h = createReactHarness()
  previousTheme = document.documentElement.getAttribute('data-theme')
})
afterEach(() => {
  h.cleanup()
  if (previousTheme === null) document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', previousTheme)
})

async function draw(language: string, theme: string, fill = false) {
  await page.viewport(900, 900)
  document.documentElement.dataset.theme = theme
  await i18n.changeLanguage(language)
  h.container.style.width = fill ? '240px' : '600px'
  await renderWithAppProviders(h, <MemberProfileCard member={member} fill={fill} aliasControls={{ alias: 'Test alias', onSave: vi.fn() }} />, { contacts: {} })
  await until('the real profile fields are rendered', () => h.container.querySelector('[data-profile-field="role"]') !== null)
  await document.fonts.ready
}

function assertFields() {
  const fields = h.container.querySelector<HTMLElement>('.gg-pop-fields')!
  const labels = [...fields.querySelectorAll<HTMLElement>('.gg-pop-field-label')]
  const values = [...fields.querySelectorAll<HTMLElement>('.gg-pop-field-value, [data-profile-alias-input]')]
  expect(labels.length).toBe(values.length)
  expect(labels.length).toBe(5)
  const lefts = values.map((value) => value.getBoundingClientRect().left)
  expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThan(1)
  for (const [index, label] of labels.entries()) {
    const range = document.createRange()
    range.selectNodeContents(label)
    const fragments = [...range.getClientRects()]
    expect(fragments, `one line for ${label.textContent}`).toHaveLength(1)
    expect(fragments[0].right).toBeLessThanOrEqual(values[index].getBoundingClientRect().left)
    expect(values[index].getBoundingClientRect().right).toBeLessThanOrEqual(fields.getBoundingClientRect().right)
  }
  const role = fields.querySelector<HTMLElement>('[data-profile-field="role"]')!
  const caption = getComputedStyle(fields).getPropertyValue('--font-caption').trim()
  expect(getComputedStyle(role).fontSize).toBe(caption)
  expect(getComputedStyle(role).lineHeight).toBe(getComputedStyle(fields).getPropertyValue('--lh-caption').trim())
  const email = fields.querySelector<HTMLElement>('[data-profile-field="email"]')!
  expect(email.scrollWidth).toBeLessThanOrEqual(email.clientWidth + 1)
  expect(email.getBoundingClientRect().height).toBeGreaterThan(parseFloat(getComputedStyle(email).lineHeight))
  expect(fields.scrollWidth).toBeLessThanOrEqual(fields.clientWidth + 1)
  expect(role.textContent).toBe(i18n.t('profile.roles.owner', { ns: 'contacts' }))
  expect(email.textContent).toBe(member.email)
  expect(fields.querySelector('[data-profile-field="bio"]')?.textContent).toBe(member.bio)
}

for (const language of ['en-US', 'zh-CN']) {
  for (const theme of ['light', 'dark']) {
    it(`${language}/${theme}: keeps labels on one line and all values in a shared column`, async () => {
      await draw(language, theme)
      assertFields()
    })
  }
  it(`${language}: keeps long values inside the narrow fill card`, async () => {
    await draw(language, 'light', true)
    assertFields()
    expect(h.container.querySelector('.gg-pop')!.getBoundingClientRect().width).toBe(240)
  })
}

it('keeps the alias editor and the normal message action operational', async () => {
  const onSave = vi.fn()
  const onOpenChat = vi.fn()
  await i18n.changeLanguage('en-US')
  await renderWithAppProviders(h, <MemberProfileCard member={member} onOpenChat={onOpenChat} aliasControls={{ alias: 'Old alias', onSave }} />, { contacts: {} })
  await page.getByPlaceholder('Not set', { exact: true }).fill('New alias')
  await userEvent.keyboard('{Enter}')
  expect(onSave).toHaveBeenCalledExactlyOnceWith('New alias')
  await page.getByTestId('member-profile-send-message-button').click()
  expect(onOpenChat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: member.id, type: 'human' }))
})

it('adapts the common value-column start when the rendered labels change language', async () => {
  await draw('en-US', 'light')
  const start = () => h.container.querySelector('[data-profile-field="role"]')!.getBoundingClientRect().left
  const english = start()
  await draw('zh-CN', 'light')
  expect(english).toBeGreaterThan(start())
})
