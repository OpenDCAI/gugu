import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth'
import { ChevronLeft, ChevronRight } from '@/lib/icons'
import { useAssistantPanelBack } from '@/lib/assistantPanelPage'
import { Button } from '@/components/ui/Button'
import { SearchField } from '@/components/ui/SearchField'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { SettingsRow } from '@/components/settings/SettingsPrimitives'
import { AppConnectionListPlaceholder } from './AppConnectionHero'
import { categoryLabel, connectedAppsCatalog } from './connected-app-catalog'
import { useConnectedAppView } from './connected-app-view'
import type { AssistantConnectedApp } from './assistant-app-connections'
import './connected-app-catalog.css'

type Props = {
  apps: readonly AssistantConnectedApp[]
  scope: string
  open: (id: string) => void
  icon: (app: AssistantConnectedApp, size: number) => ReactNode
  mobile?: boolean
  panelNavigation?: boolean
  connectionRead?: 'ready' | 'pending' | 'failed'
  retryConnections?: () => void
}

/** Data ownership and authorization stay with the existing platform adapters. */
export function ConnectedAppsCatalog(props: Props) {
  const owner = useAuth().user?.id ?? 'signed-out'
  const scope = JSON.stringify([owner, props.scope])
  return <ConnectedAppsCatalogContent key={scope} {...props} scope={scope} />
}

function ConnectedAppsCatalogContent({
  apps,
  scope,
  open,
  icon,
  mobile = false,
  panelNavigation = false,
  connectionRead = 'ready',
  retryConnections
}: Props) {
  const { t, i18n } = useTranslation('assistant')
  const { root, view, change, rememberScroll } = useConnectedAppView(scope)
  const catalog = connectedAppsCatalog(apps, view, i18n.language)
  const panelId = useId()
  const leaveCategory = () => change({ ...view, category: null })
  useAssistantPanelBack(
    panelNavigation && view.category ? `connected-app-category:${scope}` : null,
    leaveCategory
  )
  const openApp = (id: string) => {
    rememberScroll()
    open(id)
  }
  const browse = () => change({ tab: 'all', query: '', category: null })
  const row = (app: AssistantConnectedApp) => (
    <SettingsRow
      key={app.id}
      className="connected-app-row"
      data-testid={`assistant-connector-${app.id}`}
      leading={icon(app, 32)}
      title={app.connectionStatus ? `${app.name} · ${app.connectionStatus}` : app.name}
      description={app.description || <span aria-hidden="true">&nbsp;</span>}
      control={
        !app.connectionStatus && app.saved && app.state !== 'connected' ? (
          <span className="connected-app-status" data-state={app.state}>
            {t(`connectors.${app.state}`)}
          </span>
        ) : (
          <ChevronRight className="size-4" aria-hidden />
        )
      }
      onClick={() => openApp(app.id)}
    />
  )
  const section = (
    id: string,
    title: string,
    items: readonly AssistantConnectedApp[],
    count?: number,
    action?: ReactNode
  ) => (
    <section className="connected-app-section" key={id} data-testid={`assistant-connectors-${id}`}>
      <div className="connected-app-section-head">
        <h2>
          {title}
          {count !== undefined ? <span className="connected-app-count">{count}</span> : null}
        </h2>
        {action}
      </div>
      <div className="connected-app-rows">{items.map(row)}</div>
    </section>
  )

  let body: ReactNode
  if (view.tab === 'mine' && connectionRead !== 'ready') {
    body =
      connectionRead === 'pending' ? (
        <AppConnectionListPlaceholder />
      ) : (
        <div className="connected-app-empty" role="status">
          <p>{t('connectors.loadFailed')}</p>
          {retryConnections ? (
            <Button onClick={retryConnections}>{t('machine.retry')}</Button>
          ) : null}
        </div>
      )
  } else if (view.tab === 'mine' && catalog.myTotal === 0 && !catalog.searching && !view.category) {
    body = (
      <div className="connected-app-empty" data-testid="connected-apps-empty">
        <p>{t('connectors.catalog.noConnections')}</p>
        <Button className="connected-app-browse" onClick={browse}>
          {t('connectors.catalog.browse')}
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    )
  } else if (!catalog.results.length) {
    body = (
      <div className="connected-app-empty" role="status">
        <p>{t('connectors.catalog.noResults')}</p>
        {catalog.searching ? (
          <Button onClick={() => change({ ...view, query: '' })}>
            {t('connectors.catalog.clearSearch')}
          </Button>
        ) : null}
        {view.tab === 'mine' ? (
          <Button variant="ghost" onClick={() => change({ ...view, tab: 'all' })}>
            {t('connectors.catalog.searchAll')}
          </Button>
        ) : null}
      </div>
    )
  } else if (catalog.searching) {
    body = section(
      'results',
      t('connectors.catalog.results'),
      catalog.results,
      catalog.results.length
    )
  } else if (view.tab === 'mine') {
    body = (
      <>
        {catalog.attention.length
          ? section(
              'attention',
              t('connectors.catalog.attention'),
              catalog.attention,
              catalog.attention.length
            )
          : null}
        {catalog.connected.length
          ? section(
              'connected',
              t('connectors.connectedGroup'),
              catalog.connected,
              catalog.connected.length
            )
          : null}
      </>
    )
  } else if (catalog.grouped) {
    body = (
      <>
        {catalog.featured.length ? (
          <section className="connected-app-section" data-testid="connected-apps-featured">
            <div className="connected-app-section-head">
              <h2>{t('connectors.catalog.featured')}</h2>
            </div>
            <div className="connected-app-featured-grid">
              {catalog.featured.map((app) => (
                <Button
                  key={app.id}
                  variant="ghost"
                  className="connected-app-featured-card"
                  onClick={() => openApp(app.id)}
                  aria-label={`${t('connectors.catalog.viewApp')} · ${app.name}`}
                >
                  <span className="connected-app-featured-icon">{icon(app, 48)}</span>
                  <span className="connected-app-featured-title">{app.name}</span>
                  <span className="connected-app-featured-description">{app.description}</span>
                  <span className="connected-app-featured-action">
                    {t('connectors.catalog.viewApp')}
                    <ChevronRight className="size-4" aria-hidden />
                  </span>
                </Button>
              ))}
            </div>
          </section>
        ) : null}
        {catalog.categories.map((group) =>
          section(
            `category-${group.id}`,
            group.title,
            group.preview,
            undefined,
            group.items.length > group.preview.length ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => change({ ...view, category: group.id })}
              >
                {t('connectors.catalog.viewAll', { count: group.items.length })}
                <ChevronRight className="size-4" aria-hidden />
              </Button>
            ) : undefined
          )
        )}
      </>
    )
  } else {
    body = section(
      'all',
      view.category ? categoryLabel(view.category, i18n.language) : t('connectors.catalog.all'),
      catalog.results
    )
  }

  return (
    <div ref={root} className="connected-app-catalog" data-mobile={mobile || undefined}>
      <div className="connected-app-toolbar">
        <SearchField
          className="connected-app-search"
          value={view.query}
          placeholder={t('connectors.catalog.search')}
          clearLabel={t('connectors.catalog.clearSearch')}
          aria-label={
            view.category
              ? `${t('connectors.catalog.search')} · ${categoryLabel(view.category, i18n.language)}`
              : t('connectors.catalog.search')
          }
          onValueChange={(query) => change({ ...view, query })}
          onClear={() => change({ ...view, query: '' })}
        />
        <SegmentedTabs
          ariaLabel={t('connectors.title')}
          value={view.tab}
          onChange={(tab) => change({ ...view, tab })}
          items={[
            { value: 'all', label: t('connectors.catalog.all'), panelId },
            { value: 'mine', label: t('connectors.catalog.mine'), panelId }
          ]}
        />
      </div>
      {view.category ? (
        <div className="connected-app-category-back">
          <Button variant="ghost" onClick={leaveCategory}>
            <ChevronLeft className="size-4" aria-hidden />
            {t('connectors.catalog.backToAll')}
          </Button>
        </div>
      ) : null}
      <div
        className="connected-app-content"
        role="tabpanel"
        id={panelId}
        aria-label={t(view.tab === 'all' ? 'connectors.catalog.all' : 'connectors.catalog.mine')}
      >
        {body}
      </div>
    </div>
  )
}
