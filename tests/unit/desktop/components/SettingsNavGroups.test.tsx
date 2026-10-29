// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SETTINGS_SECTIONS,
  SESSION_HOST_SETTINGS_SECTIONS,
} from '../../../../packages/core/src/shared/enums/settingsSectionModels'
import { SettingsNav } from '../../../../apps/desktop/src/components/settings/SettingsNav'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const render = (sections: readonly string[], extra: { assistantName?: string | null } = {}) =>
  renderWithAppProviders(harness, createNode(SettingsNav, {
    activeSection: 'account',
    sections,
    user: { id: 'u-1', nickname: 'Tester', avatarUrl: null },
    onSelect: () => {},
    ...extra,
  }), { auth: { id: 'u-1', email: 'owner@example.com', nickname: 'Tester' } })

const groups = () =>
  [...harness.container.querySelectorAll('[role="group"]')].map((group) =>
    [...group.querySelectorAll('[data-testid^="settings-nav-"]')].map((row) => row.getAttribute('data-testid')!.replace('settings-nav-', '')))

const captions = () => [...harness.container.querySelectorAll('.gg-settings-nav-caption')].map((el) => el.textContent)

// product spec:一个设置,左栏分组,每组一行小标题。咕咕自己的设置是其中第一组(owner 10-16)。
describe('the one settings nav', () => {
  it('draws every section in its group, in the spec order', async () => {
    await render(SETTINGS_SECTIONS)
    expect(groups()).toEqual([
      ['assistant', 'connectors'],
      ['account', 'usage', 'subscriptions'],
      ['general', 'interface', 'permissions', 'model', 'resource-monitor'],
      ['sessions', 'browser', 'devices', 'apps', 'phone'],
      ['about'],
    ])
  })

  // 手机「我的」没有会话页那几格(订阅、云端连接应用也在其中:读数要会话页宿主):同一份分组,少掉的格不画,整组空了就连组带小标题一起不画。
  it('drops the sections a host does not show, and a group left empty', async () => {
    await render(SETTINGS_SECTIONS.filter((section) => !SESSION_HOST_SETTINGS_SECTIONS.includes(section) && section !== 'devices' && section !== 'channels' && section !== 'apps' && section !== 'phone'))
    expect(groups()).toEqual([
      ['assistant'],
      ['account', 'usage'],
      ['general', 'permissions', 'model'],
      ['about'],
    ])
  })

  it('drops the whole 咕咕 group when the host has no cloud computer', async () => {
    await render(SETTINGS_SECTIONS.filter((section) => section !== 'assistant' && section !== 'connectors'))
    expect(groups()[0]).toEqual(['account', 'usage', 'subscriptions'])
  })

  // 组名:咕咕那组用它现在的名字;「关于」组只有一格、同名,不画小标题。手机上咕咕组只剩「资料」一格也画组名(否则不知道是谁的资料)。
  it('captions each group, the first with the assistant name; 关于 has none', async () => {
    await render(SETTINGS_SECTIONS, { assistantName: '小咕' })
    expect(captions()).toHaveLength(4)
    expect(captions()[0]).toBe('小咕')
    expect(harness.container.querySelector('[data-group="about"] .gg-settings-nav-caption')).toBeNull()
    harness.cleanup()
    harness = createReactHarness()
    await render(['assistant', 'account'], { assistantName: null })
    expect(captions()[0]).toBe('咕咕')
  })

  it('has no second 咕咕 entry: the assistant section is the only one that opens its settings', async () => {
    await render(SETTINGS_SECTIONS)
    expect(harness.container.querySelector('[data-testid="settings-nav-layer-assistant"]')).toBeNull()
    expect(harness.container.querySelectorAll('[data-testid="settings-nav-assistant"]')).toHaveLength(1)
  })
})
