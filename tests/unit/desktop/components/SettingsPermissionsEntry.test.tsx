// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTINGS_SECTIONS } from '../../../../packages/core/src/shared/enums/settingsSectionModels'
import { SettingsNav } from '../../../../apps/desktop/src/components/settings/SettingsNav'
import { platform } from '../../../../apps/desktop/src/platform'
import { systemPermissionRows } from '../../../../apps/desktop/src/lib/systemPermissions'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const nav = (sections: readonly string[]) => createNode(SettingsNav, {
  activeSection: 'account',
  sections,
  mobile: true,
  user: { id: 'u-1', nickname: 'Tester', avatarUrl: null },
  onSelect: () => {},
})

// product spec:「我的」里单独一项「权限」,桌面手机同一页。
// 这条钉的是入口本身 —— PermissionsSection 写好了、SettingsNav 里也登记了图标与文案,
// 但只要 core 那两份清单里少这一项,SettingsNav 那句 filter 就把它整条滤掉,「我的」永远长不出「权限」。
// 只测子页组件的单测看不见这一格。
describe('settings 「权限」 entry', () => {
  it('renders the permissions row from the one section list', async () => {
    for (const sections of [SETTINGS_SECTIONS]) {
      expect(sections).toContain('permissions')
      harness.cleanup()
      harness = createReactHarness()
      await renderWithAppProviders(harness, nav(sections), { auth: { id: 'u-1', email: 'owner@example.com', nickname: 'Tester' } })
      expect(harness.container.querySelector('[data-testid="settings-nav-permissions"]')).toBeTruthy()
    }
  })

  // 「读不到系统真值的宿主不列」——jsdom 里解析出来的是 web 宿主,它一行都读不到。
  it('lists no rows on a host that cannot read system permission truth', () => {
    expect(platform.systemPermissions).toEqual([])
    expect(systemPermissionRows()).toEqual([])
  })
})
