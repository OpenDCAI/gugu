import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { Menu, MenuItem } from '@/components/ui/Menu'
import { Button } from '@/components/ui/Button'
import { ProjectFolderAvatar } from '@/mobile/partners/ProjectFolderAvatar'
import '@/i18n'
import '@/styles/tokens.css'
import '@/mobile/phone-look.css'
import '@/mobile/partners/partners.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({
  ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key',
}))
let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => { await page.viewport(390, 844); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); document.querySelectorAll('[data-portal-probe]').forEach(e => e.remove()); delete document.documentElement.dataset.theme })

it.each(['light', 'dark'] as const)('%s: an actual portalled menu keeps phone spacing and nested neutral tokens', async theme => {
  document.documentElement.dataset.theme = theme
  await harness.render(<div data-phone-shell=""><button data-anchor>Open menu</button></div>)
  const anchor = harness.container.querySelector('[data-anchor]')!
  await harness.render(<div data-phone-shell=""><button data-anchor>Open menu</button><Menu anchor={anchor}><MenuItem>Nested menu item</MenuItem></Menu></div>)
  await until('portal painted', () => !!document.querySelector('.gg-menu-item'))
  const menu = document.querySelector<HTMLElement>('.gg-menu')!
  const item = document.querySelector<HTMLElement>('.gg-menu-item')!
  expect(menu.closest('[data-phone-shell]')).toBeNull()
  const style = getComputedStyle(item)
  expect(style.paddingLeft).toBe('16px')
  expect(style.paddingTop).toBe('8px')
  expect(item.getBoundingClientRect().height).toBeGreaterThanOrEqual(44)
  const probe = document.createElement('div')
  probe.dataset.taMenu = ''; probe.dataset.portalProbe = ''; probe.style.background = 'var(--ta-panel-bg)'
  document.body.append(probe)
  expect(getComputedStyle(probe).backgroundImage).toBe('none')
  expect(getComputedStyle(probe).backgroundColor).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(24, 24, 24)')
})

it('desktop portalled menus preserve their original density', async () => {
  await harness.render(<button data-anchor>Open menu</button>)
  const anchor = harness.container.querySelector('[data-anchor]')!
  await harness.render(<><button data-anchor>Open menu</button><Menu anchor={anchor}><MenuItem>Desktop item</MenuItem></Menu></>)
  await until('portal painted', () => !!document.querySelector('.gg-menu-item'))
  const style = getComputedStyle(document.querySelector('.gg-menu-item')!)
  expect(style.paddingLeft).toBe('10px')
  expect(style.paddingTop).toBe('6px')
})

it('the search surface stays steady under hover and a keyboard press', async () => {
  document.documentElement.dataset.theme = 'light'
  await harness.render(<div data-phone-shell="" className="ta-phone"><Button variant="ghost" className="gg-phone-nav-search">Search</Button></div>)
  const button = harness.container.querySelector('button')!
  const background = getComputedStyle(button).backgroundColor
  await userEvent.hover(button)
  await until('hover transition settled', () => getComputedStyle(button).backgroundColor === background)
  button.focus()
  await userEvent.keyboard('{Space>}')
  expect(button.matches(':active')).toBe(true)
  expect(getComputedStyle(button).backgroundColor).toBe(background)
  await userEvent.keyboard('{/Space}')
})

it('small project avatars draw one stable cover with unique clipping', async () => {
  await harness.render(<div data-phone-shell=""><ProjectFolderAvatar coverId="same-project" size={32} /><ProjectFolderAvatar coverId="same-project" size={40} /></div>)
  const icons = [...harness.container.querySelectorAll<SVGSVGElement>('.gg-project-avatar')]
  expect(icons).toHaveLength(2)
  expect(icons.map(icon => icon.getBoundingClientRect().width)).toEqual([32, 40])
  const clips = [...harness.container.querySelectorAll('clipPath')]
  expect(clips).toHaveLength(2)
  expect(new Set(clips.map(clip => clip.id)).size).toBe(2)
  for (const icon of icons) expect(icon.querySelectorAll('.gg-project-avatar-cover')).toHaveLength(1)
})
