import { describe, expect, it } from 'vitest'
import { builtinIntegrationSummaries } from '@gugu/session-plugins/integration-summaries'
import {
  appCategory,
  connectedAppsCatalog,
  INITIAL_CONNECTED_APPS_VIEW,
  type CatalogApp,
  type ConnectedAppsView
} from '../../../../apps/desktop/src/components/assistant/connected-app-catalog'

function app(id: string, categoryId = 'tasks', changes: Partial<CatalogApp> = {}): CatalogApp {
  return {
    id,
    name: id,
    description: '',
    saved: false,
    state: 'notConnected',
    catalog: { categoryId },
    ...changes
  }
}
function view(changes: Partial<ConnectedAppsView> = {}): ConnectedAppsView {
  return { ...INITIAL_CONNECTED_APPS_VIEW, ...changes }
}
const builtins = Object.entries(builtinIntegrationSummaries).map(([id, summary]) =>
  app(id, summary.catalog.categoryId, {
    name: summary.name['zh-CN'],
    description: summary.description['zh-CN'],
    catalog: summary.catalog
  })
)

describe('connected-app directory', () => {
  it('classifies all 23 built-ins and WeChat exactly once into the approved seven categories', () => {
    const result = connectedAppsCatalog([...builtins, app('wechat', 'mail')], view(), 'zh-CN')
    expect(result.total).toBe(24)
    expect(result.categories.map((group) => [group.id, group.items.length])).toEqual([
      ['work', 4],
      ['docs', 3],
      ['tasks', 7],
      ['dev', 3],
      ['mail', 4],
      ['support', 2],
      ['life', 1]
    ])
    expect(
      new Set(result.categories.flatMap((group) => group.items.map((item) => item.id))).size
    ).toBe(24)
    expect(
      result.categories
        .filter((group) => group.items.length > group.preview.length)
        .map((group) => group.id)
    ).toEqual(['tasks'])
  })

  it('preserves unknown providers and missing or unrecognized categories under Other', () => {
    expect(appCategory(app('new', 'unknown'))).toBe('other')
    expect(appCategory({})).toBe('other')
    expect(appCategory(app('new', 'toString'))).toBe('other')
    const result = connectedAppsCatalog([...builtins, app('new', 'future')], view(), 'en')
    expect(result.categories.at(-1)?.items.map((item) => item.id)).toEqual(['new'])
    expect(result.categories.slice(0, 3).map((group) => group.id)).toEqual([
      'tasks',
      'docs',
      'work'
    ])
  })

  it('deduplicates provider counts without counting featured entries again', () => {
    const result = connectedAppsCatalog([...builtins, builtins[0]!], view(), 'zh-CN')
    expect(result.total).toBe(23)
    expect(result.featured.map((item) => item.id)).toEqual(['feishu', 'github'])
    expect(result.results.filter((item) => item.id === 'feishu')).toHaveLength(1)
  })

  it('keeps saved but unhealthy connections visible separately from checked connections', () => {
    const input = [
      app('good', 'docs', { state: 'connected' }),
      ...(
        ['unverified', 'checking', 'needsReauth', 'checkFailed', 'paused', 'retrying'] as const
      ).map((state) => app(state, 'mail', { state, saved: true })),
      app('not-saved')
    ]
    const result = connectedAppsCatalog(input, view({ tab: 'mine' }), 'en')
    expect(result.myTotal).toBe(7)
    expect(result.connected.map((item) => item.id)).toEqual(['good'])
    expect(result.attention.map((item) => item.state)).toEqual([
      'unverified',
      'checking',
      'needsReauth',
      'checkFailed',
      'paused',
      'retrying'
    ])
    expect(result.featured).toEqual([])
  })

  it('uses bilingual names, summaries, categories and maintained aliases with width normalization', () => {
    const ids = (query: string) =>
      connectedAppsCatalog(builtins, view({ query }), 'en').results.map((item) => item.id)
    expect(ids(' ＧｉｔＨｕｂ ')).toEqual(['github'])
    expect(ids('Feishu')).toEqual(['feishu'])
    expect(ids('飞书')).toEqual(['feishu'])
    expect(ids('Baidu Netdisk')).toEqual(['baidu-pan'])
    expect(ids('GitHub 开发工具')).toEqual(['github'])
    expect(ids('docs files')).toEqual(['baidu-pan', 'notion', 'tencent-docs'])
    expect(ids('Lark')).toEqual([])
    expect(ids('GitHub unrelated')).toEqual([])
  })

  it('does not index account emails, credentials or other arbitrary object fields', () => {
    const withAccount = {
      ...app('public'),
      accountEmail: 'private@example.invalid',
      credentials: 'private-secret',
      toolSchema: 'secret-tool'
    }
    for (const query of ['private@example.invalid', 'private-secret', 'secret-tool']) {
      expect(connectedAppsCatalog([withAccount], view({ query }), 'en').results).toEqual([])
    }
  })

  it('ranks exact names and aliases above descriptive matches while requiring every query term', () => {
    const items = [
      app('description', 'tasks', { description: 'Linear tasks' }),
      app('linear'),
      app('alias', 'tasks', { catalog: { categoryId: 'tasks', aliases: ['Linear'] } })
    ]
    expect(
      connectedAppsCatalog(items, view({ query: 'Linear' }), 'en').results.map((item) => item.id)
    ).toEqual(['linear', 'alias', 'description'])
  })

  it('limits search to the active tab and category, retaining flattened results', () => {
    const items = [
      app('one', 'docs', { name: 'Shared name', saved: true }),
      app('two', 'dev', { name: 'Shared name' })
    ]
    expect(
      connectedAppsCatalog(items, view({ tab: 'mine', query: 'shared' }), 'en').results.map(
        (item) => item.id
      )
    ).toEqual(['one'])
    expect(
      connectedAppsCatalog(items, view({ category: 'dev', query: 'shared' }), 'en').results.map(
        (item) => item.id
      )
    ).toEqual(['two'])
    expect(connectedAppsCatalog(builtins, view({ query: 'mail' }), 'en').grouped).toBe(false)
  })

  it('shows a complete compact list through eight apps, enabling groups and featured cards at nine', () => {
    const input = [
      app('feishu', 'work'),
      app('github', 'dev'),
      ...Array.from({ length: 7 }, (_, i) => app(`item-${i}`))
    ]
    expect(connectedAppsCatalog(input.slice(0, 8), view(), 'zh-CN').grouped).toBe(false)
    expect(connectedAppsCatalog(input.slice(0, 8), view(), 'zh-CN').featured).toEqual([])
    expect(connectedAppsCatalog(input, view(), 'zh-CN').featured).toHaveLength(2)
  })

  it('replenishes featured candidates while excluding saved connections and known failures', () => {
    const items = builtins.map((item) =>
      item.id === 'feishu'
        ? { ...item, saved: true, state: 'needsReauth' as const }
        : item.id === 'github'
          ? { ...item, state: 'checkFailed' as const }
          : item
    )
    expect(connectedAppsCatalog(items, view(), 'zh-CN').featured.map((item) => item.id)).toEqual([
      'notion',
      'dida'
    ])
    expect(connectedAppsCatalog(builtins, view(), 'en').featured.map((item) => item.id)).toEqual([
      'notion',
      'github'
    ])
    expect(
      connectedAppsCatalog(
        items.filter((item) => item.id !== 'dida'),
        view(),
        'zh-CN'
      ).featured
    ).toEqual([])
  })

  it('hides featured cards in search, category and management views', () => {
    for (const state of [
      view({ query: 'GitHub' }),
      view({ category: 'tasks' }),
      view({ tab: 'mine' })
    ]) {
      expect(connectedAppsCatalog(builtins, state, 'zh-CN').featured).toEqual([])
    }
    expect(
      connectedAppsCatalog(builtins, view({ category: 'tasks' }), 'zh-CN').results
    ).toHaveLength(7)
  })
})
