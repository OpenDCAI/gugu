import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { builtinIntegrationSummaries } from '@gugu/session-plugins/integration-summaries'
import { integrationIcons } from '@gugu/session-plugins/integration-icons'
import {
  createReactHarness,
  renderWithAppProviders
} from '../../../../../../../tests/support/testHarness'
import { ConnectedAppsCatalog } from '@/components/assistant/ConnectedAppsCatalog'
import type { AssistantConnectedApp } from '@/components/assistant/assistant-app-connections'
import { PluginIcon } from '@/session/renderer/lib/components/plugin-icon'
import { ChannelBrandIcon } from '@/components/settings/channels/ChannelBrandIcon'
import { i18n } from '@/i18n'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerAssistantCatalog'
import '@/styles/tokens.css'
import '@/session/renderer/features/assistant/assistant-today.css'
import '@/mobile/assistant/assistant-phone.css'
import '@/mobile/phone-look.css'

let harness: ReturnType<typeof createReactHarness>
let scope = 0
const open = vi.fn()
const apps: AssistantConnectedApp[] = [
  ...Object.entries(builtinIntegrationSummaries).map(([id, summary]) => ({
    id,
    name: summary.name['zh-CN'],
    description: summary.description['zh-CN'],
    catalog: summary.catalog,
    state: 'notConnected' as const,
    saved: false
  })),
  {
    id: 'wechat',
    name: '微信',
    description: '在微信里和咕咕聊天',
    catalog: { categoryId: 'mail', aliases: ['WeChat'] },
    state: 'notConnected',
    saved: false
  }
]
const withConnections = apps.map((app) =>
  app.id === 'dingtalk'
    ? { ...app, saved: true, state: 'needsReauth' as const }
    : ['notion', 'qq-mail'].includes(app.id)
      ? { ...app, saved: true, state: 'connected' as const }
      : app
)

async function render(
  items = apps,
  mobile = false,
  owner = 'catalog-owner',
  connectionRead: 'ready' | 'pending' | 'failed' = 'ready'
) {
  harness.container.toggleAttribute('data-phone-shell', mobile)
  harness.container.classList.toggle('ta-phone', mobile)
  harness.container.style.cssText = `width:${mobile ? 390 : 640}px;height:760px;overflow:auto;background:var(--bg);`
  await renderWithAppProviders(
    harness,
    <ConnectedAppsCatalog
      apps={items}
      scope={`catalog-browser-${scope}`}
      open={open}
      mobile={mobile}
      connectionRead={connectionRead}
      icon={(app, size) =>
        app.id === 'wechat' ? (
          <ChannelBrandIcon kind="wechat" size={size} />
        ) : (
          <PluginIcon id={app.id} icon={integrationIcons[app.id]!} size={size} />
        )
      }
    />,
    { auth: { id: owner } }
  )
}

beforeEach(async () => {
  scope++
  open.mockReset()
  await page.viewport(900, 900)
  await i18n.changeLanguage('zh-CN')
  document.documentElement.dataset.theme = 'dark'
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  delete document.documentElement.dataset.theme
})

it.each(['light', 'dark'])(
  'keeps row surfaces distinct and warning text legible in %s',
  async (theme) => {
    document.documentElement.dataset.theme = theme
    await render(withConnections)
    const rows = harness.container.querySelector<HTMLElement>('.connected-app-rows')!
    expect(getComputedStyle(rows).backgroundColor).not.toBe(
      getComputedStyle(harness.container).backgroundColor
    )
    const status = harness.container.querySelector<HTMLElement>('.connected-app-status')!
    const context = document.createElement('canvas').getContext('2d')!
    function luminance(color: string) {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = getComputedStyle(harness.container).backgroundColor
      context.fillRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
        const channel = value / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
    }
    const foreground = luminance(getComputedStyle(status).color)
    const background = luminance(getComputedStyle(rows).backgroundColor)
    expect(
      (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
    ).toBeGreaterThanOrEqual(4.5)
  }
)

it.each([false, true])(
  'renders equal full-width tabs, two featured entries and seven real categories (phone=%s)',
  async (mobile) => {
    await render(apps, mobile)
    const tabs = harness.container.querySelectorAll<HTMLElement>('[role="tab"]')
    expect(tabs).toHaveLength(2)
    expect(
      Math.abs(tabs[0]!.getBoundingClientRect().width - tabs[1]!.getBoundingClientRect().width)
    ).toBeLessThan(1)
    expect(harness.container.querySelectorAll('.connected-app-featured-card')).toHaveLength(2)
    expect(
      harness.container.querySelectorAll('[data-testid^="assistant-connectors-category-"]')
    ).toHaveLength(7)
    expect(harness.container.scrollWidth).toBe(harness.container.clientWidth)
    const search = harness.container.querySelector<HTMLElement>('.connected-app-search')!
    expect(getComputedStyle(search).boxShadow).toBe('none')
    expect(getComputedStyle(search).borderTopWidth).toBe('0px')
    await act(async () => {
      await page.getByRole('button', { name: '查看应用 · 飞书', exact: true }).click()
    })
    expect(open).toHaveBeenCalledExactlyOnceWith('feishu')
    const row = harness.container.querySelector<HTMLElement>(
      '[data-testid="assistant-connector-github"]'
    )!
    row.focus()
    await act(async () => {
      await userEvent.keyboard('{Enter}')
    })
    expect(open).toHaveBeenLastCalledWith('github')
  }
)

it('uses the same real state groups on both tabs and has no repeated browse action when connections exist', async () => {
  await render(withConnections)
  await act(async () => {
    await page.getByRole('tab', { name: '我的连接', exact: true }).click()
  })
  expect(
    harness.container.querySelector('[data-testid="assistant-connectors-attention"] h2')
      ?.textContent
  ).toBe('需要处理1')
  expect(
    harness.container.querySelector('[data-testid="assistant-connectors-connected"] h2')
      ?.textContent
  ).toBe('已连接2')
  expect(harness.container.querySelectorAll('.connected-app-row')).toHaveLength(3)
  expect(harness.container.querySelector('.connected-app-status')?.textContent).toBe('需要重新授权')
  expect(harness.container.querySelector('.connected-app-browse')).toBeNull()
  expect(harness.container.querySelector('.connected-app-featured-grid')).toBeNull()
})

it.each(['light', 'dark'])(
  'shows the short empty state and a working browse button in %s',
  async (theme) => {
    document.documentElement.dataset.theme = theme
    await render(apps, true)
    await act(async () => {
      await page.getByRole('tab', { name: '我的连接', exact: true }).click()
    })
    expect(harness.container.querySelector('.connected-app-empty p')?.textContent).toBe(
      '还没有连接任何应用'
    )
    expect(harness.container.querySelector('h2')).toBeNull()
    const browse = harness.container.querySelector<HTMLElement>('.connected-app-browse')!
    expect(browse.getBoundingClientRect().width).toBe(harness.container.clientWidth)
    expect(browse.getBoundingClientRect().height).toBeGreaterThanOrEqual(44)
    await act(async () => {
      await page.getByRole('button', { name: '浏览全部应用', exact: true }).click()
    })
    expect(harness.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      '全部应用'
    )
    expect(harness.container.querySelector('.connected-app-featured-grid')).not.toBeNull()
  }
)

it('searches only the current tab and preserves the query when switching tabs', async () => {
  await render(withConnections)
  await act(async () => {
    await userEvent.fill(page.getByRole('searchbox', { name: '搜索应用', exact: true }), 'Feishu')
  })
  expect(harness.container.querySelectorAll('.connected-app-row')).toHaveLength(1)
  expect(harness.container.querySelector('.connected-app-row')?.textContent).toContain('飞书')
  expect(harness.container.querySelector('.connected-app-featured-grid')).toBeNull()
  await act(async () => {
    await page.getByRole('tab', { name: '我的连接', exact: true }).click()
  })
  expect(harness.container.querySelector('input')?.value).toBe('Feishu')
  expect(harness.container.querySelector('.connected-app-empty p')?.textContent).toBe(
    '没有找到相关应用'
  )
  await act(async () => {
    await page.getByRole('button', { name: '搜索全部应用', exact: true }).click()
  })
  expect(harness.container.querySelectorAll('.connected-app-row')).toHaveLength(1)
})

it('opens a complete category, restores its query after details, and isolates another account', async () => {
  await render()
  await act(async () => {
    await page.getByRole('button', { name: '查看全部（7）', exact: true }).click()
  })
  expect(harness.container.querySelectorAll('.connected-app-row')).toHaveLength(7)
  await act(async () => {
    await userEvent.fill(
      page.getByRole('searchbox', { name: '搜索应用 · 任务与项目', exact: true }),
      'Linear'
    )
  })
  await act(async () => {
    await page.getByRole('button', { name: 'Linear 处理 Linear 工单', exact: true }).click()
  })
  expect(open).toHaveBeenLastCalledWith('linear')
  await harness.render(null)
  await render()
  expect(harness.container.querySelector('input')?.value).toBe('Linear')
  expect(harness.container.querySelectorAll('.connected-app-row')).toHaveLength(1)
  await render(apps, false, 'another-owner')
  expect(harness.container.querySelector('input')?.value).toBe('')
  expect(harness.container.querySelector('.connected-app-featured-grid')).not.toBeNull()
})

it('returns from a category to the previous directory scroll position', async () => {
  await render()
  const viewAll = Array.from(harness.container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent === '查看全部（7）'
  )!
  viewAll.scrollIntoView({ block: 'center' })
  const before = harness.container.scrollTop
  expect(before).toBeGreaterThan(0)
  await act(async () => {
    await page.getByRole('button', { name: '查看全部（7）', exact: true }).click()
  })
  expect(harness.container.scrollTop).toBe(0)
  await act(async () => {
    await page.getByRole('button', { name: '返回全部应用', exact: true }).click()
  })
  expect(harness.container.scrollTop).toBe(before)
})

it.each(['pending', 'failed'] as const)(
  'does not claim there are no connections before a trustworthy account read (%s)',
  async (read) => {
    await render(apps, false, 'catalog-owner', read)
    await act(async () => {
      await page.getByRole('tab', { name: '我的连接', exact: true }).click()
    })
    expect(harness.container.textContent).not.toContain('还没有连接任何应用')
    if (read === 'pending')
      expect(
        harness.container.querySelector('[data-testid="application-list-pending"]')
      ).not.toBeNull()
    else expect(harness.container.textContent).toContain('没读到连接应用')
  }
)
