import {
  builtinIntegrationSummaries,
  type IntegrationCatalogMetadata
} from '@gugu/session-plugins/integration-summaries'
import { connectorOrder } from '@/session/renderer/features/assistant/assistant-connector-order'
import type { ApplicationConnectionState } from './assistant-app-connections'

export const APP_CATEGORIES = {
  work: { en: 'Work & collaboration', 'zh-CN': '办公协作' },
  docs: { en: 'Docs & files', 'zh-CN': '文档与文件' },
  tasks: { en: 'Tasks & projects', 'zh-CN': '任务与项目' },
  dev: { en: 'Developer tools', 'zh-CN': '开发工具' },
  mail: { en: 'Mail & messaging', 'zh-CN': '邮件与消息' },
  support: { en: 'Customer support & feedback', 'zh-CN': '客户与反馈' },
  life: { en: 'Travel & everyday life', 'zh-CN': '出行与生活' },
  other: { en: 'Other', 'zh-CN': '其他' }
} as const

export type AppCategoryId = keyof typeof APP_CATEGORIES
export type ConnectedAppsView = {
  tab: 'all' | 'mine'
  query: string
  category: AppCategoryId | null
}
export const INITIAL_CONNECTED_APPS_VIEW: ConnectedAppsView = {
  tab: 'all',
  query: '',
  category: null
}
export type CatalogApp = {
  id: string
  name: string
  description: string
  saved: boolean
  state: ApplicationConnectionState
  catalog?: IntegrationCatalogMetadata
}

const CATEGORY_ORDER: Record<'zh-CN' | 'en', readonly AppCategoryId[]> = {
  'zh-CN': ['work', 'docs', 'tasks', 'dev', 'mail', 'support', 'life', 'other'],
  en: ['tasks', 'docs', 'work', 'dev', 'mail', 'support', 'life', 'other']
}
const FEATURED_CANDIDATES = {
  'zh-CN': ['feishu', 'github', 'notion', 'dida'],
  en: ['notion', 'github', 'asana', 'dida']
} as const

export function catalogLanguage(locale: string): 'zh-CN' | 'en' {
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export function appCategory(app: Pick<CatalogApp, 'catalog'>): AppCategoryId {
  const id = app.catalog?.categoryId
  return id && Object.hasOwn(APP_CATEGORIES, id) ? (id as AppCategoryId) : 'other'
}

export function categoryLabel(id: AppCategoryId, locale: string): string {
  return APP_CATEGORIES[id][catalogLanguage(locale)]
}

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')
}

/** Only explicitly selected public directory fields enter the search index. */
function searchFields(app: CatalogApp) {
  const builtin = Object.hasOwn(builtinIntegrationSummaries, app.id)
    ? builtinIntegrationSummaries[app.id]
    : undefined
  const names = [
    app.id,
    app.name,
    ...(app.catalog?.aliases ?? []),
    ...(builtin ? Object.values(builtin.name) : [])
  ].map(normalize)
  const descriptions = [
    app.description,
    ...(builtin ? Object.values(builtin.description) : []),
    ...Object.values(APP_CATEGORIES[appCategory(app)])
  ].map(normalize)
  return { names, text: [...names, ...descriptions].join(' ') }
}

function searchApps<T extends CatalogApp>(apps: readonly T[], query: string): T[] {
  const normalized = normalize(query)
  const terms = normalized.split(' ').filter(Boolean)
  if (!terms.length) return [...apps]
  return apps
    .map((app, index) => {
      const fields = searchFields(app)
      const score = fields.names.includes(normalized)
        ? 0
        : fields.names.some((name) => name.startsWith(normalized))
          ? 1
          : 2
      return { app, index, score, matches: terms.every((term) => fields.text.includes(term)) }
    })
    .filter((row) => row.matches)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((row) => row.app)
}

export function isMyConnection(app: CatalogApp): boolean {
  return app.saved || app.state === 'connected'
}

function featuredApps<T extends CatalogApp>(apps: readonly T[], locale: string): T[] {
  const candidates = FEATURED_CANDIDATES[catalogLanguage(locale)].flatMap((id) => {
    const app = apps.find((item) => item.id === id)
    return app &&
      !isMyConnection(app) &&
      !['needsReauth', 'checkFailed', 'paused', 'retrying'].includes(app.state)
      ? [app]
      : []
  })
  const first = candidates[0]
  if (!first || candidates.length < 2) return []
  const second =
    candidates.find((item) => appCategory(item) !== appCategory(first)) ?? candidates[1]!
  return [first, second]
}

/** Both clients consume this model; connection health remains an input. */
export function connectedAppsCatalog<T extends CatalogApp>(
  input: readonly T[],
  view: ConnectedAppsView,
  locale: string
) {
  const apps = connectorOrder([...new Map(input.map((app) => [app.id, app])).values()], locale)
  const mine = apps.filter(isMyConnection)
  const scope = (view.tab === 'mine' ? mine : apps).filter(
    (app) => !view.category || appCategory(app) === view.category
  )
  const results = searchApps(scope, view.query)
  const searching = normalize(view.query).length > 0
  const grouped = view.tab === 'all' && !searching && !view.category && apps.length > 8
  const categories = CATEGORY_ORDER[catalogLanguage(locale)].flatMap((id) => {
    const items = results.filter((app) => appCategory(app) === id)
    return items.length
      ? [{ id, title: categoryLabel(id, locale), items, preview: items.slice(0, 4) }]
      : []
  })
  return {
    total: apps.length,
    myTotal: mine.length,
    results,
    searching,
    grouped,
    categories,
    attention: results.filter((app) => app.state !== 'connected'),
    connected: results.filter((app) => app.state === 'connected'),
    featured: grouped ? featuredApps(apps, locale) : []
  }
}
