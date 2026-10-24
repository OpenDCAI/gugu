import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives'
import { rendererLogger } from '@/lib/log'
import { useTheme } from '@/store/theme'
import { sessionSkinClassName } from '../sessionpage/sessionSkin'
import { queryClient } from '@/session/renderer/lib/query-client'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages'
import { AppMarketContent, type MarketBrowsePage } from '@/session/renderer/features/extensions/panel/app-market-content'
import { AppProductPage } from '@/session/renderer/features/extensions/panel/app-product-page'
import { appLifecycle } from '@/session/renderer/features/extensions/panel/app-lifecycle'
import type { AppLifecycle } from '@/session/renderer/features/extensions/panel/app-lifecycle-button'
import { ShelfSkeleton } from '@/session/renderer/features/extensions/panel/extension-skeletons'
import type { ExtensionPendingAction } from '@/session/renderer/features/extensions/panel/extension-pending'
import { installedExtensionsStore as store } from '@/session/renderer/features/extensions/installed-extensions-store'
import { MARKET_PAGE_SIZE, type MarketListItem, type MarketSourceRef } from '@/session/shared/extensions/market'
import { localizedManifestText, type MarketCategory } from '@/session/shared/extensions/catalog'
import { grantableBy } from '@/session/shared/extensions/attachment-install'
import { PHONE_CAPABILITIES, phoneApps } from '../appSlot/phoneApps'
import { phoneRuns } from '../appSlot/phoneAppHost'
import { SessionAppFrame } from '../appSlot/SessionAppFrame'
import { Button } from '../ui/Button'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { SearchField } from '../ui/SearchField'
import { Sheet } from '../ui/Sheet'
import { PaneHeader } from '../ui/Pane'
import { RightPanelBackButton } from '../chat/RightPanel'
import { SettingsNote } from './SettingsPrimitives'
import { AppsSection } from './AppsSection'
import { phoneMarketRows, phoneProductApi, readPhoneMarketPage } from './phoneMarketPage'
import '@/session/renderer/index.css'
import './mobile-app-market.css'

const MARKET_KEY = ['phone-app-market']
const log = rendererLogger('settings/mobile-apps')

/** The phone supplies storage and actions; browsing and product pages are the desktop's components. */
export function MobileAppsSection() {
  return <QueryClientProvider client={queryClient}><MobileAppsContent /></QueryClientProvider>
}

const MobileAppsContent = observer(function MobileAppsContent() {
  const { translate, locale } = useSessionMessages()
  const { theme } = useTheme()
  const skin = sessionSkinClassName(theme)
  const client = useQueryClient()
  const catalog = useQuery({ queryKey: MARKET_KEY, queryFn: readPhoneMarketPage })
  const [tab, setTab] = useState<MarketBrowsePage | 'installed'>('market')
  const [query, setQuery] = useState('')
  const [chip, setChip] = useState<'all' | MarketCategory>('all')
  const [pages, setPages] = useState(1)
  const [detail, setDetail] = useState<MarketListItem | null>(null)
  const [opened, setOpened] = useState<{ kind: string; name: string } | null>(null)
  const [pending, setPending] = useState<Record<string, ExtensionPendingAction>>({})
  const inFlight = useRef(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  const sentinel = useRef<HTMLDivElement | null>(null)
  const rows = phoneMarketRows(catalog.data?.entries ?? [], query.trim())
  const hasMore = pages * MARKET_PAGE_SIZE < rows.length

  useEffect(() => {
    void phoneApps.ready().catch((error: unknown) => {
      log.warn({ error: String(error) }, 'Phone Apps unreadable')
      setFailed(translateSessionMessage('extensions.loadFailed'))
    })
    const off = phoneApps.market.onRefreshed((result) => {
      if (result.outcome === 'changed') void client.invalidateQueries({ queryKey: MARKET_KEY })
    })
    void phoneApps.market.refresh()
    return off
  }, [client])

  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasMore || tab === 'installed') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setPages((count) => count + 1)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, pages, rows.length, tab, query, chip])

  const lifecycleOf = (id: string, item: MarketListItem): AppLifecycle => {
    // The existing phone host decides whether it has a page; desktop-only host pages cannot be installed here.
    if (!phoneRuns(item.manifest) || item.manifest.contributes.tabs.some((entry) => entry.hostPage)) {
      return { kind: 'word', text: translate('extensions.needsDesktop') }
    }
    const installed = store.manifests.find((manifest) => manifest.id === id)
    return appLifecycle({ installed, enabled: store.isEnabled(id), offered: item, preinstalled: store.isPreinstalled(id), canOpen: Boolean(store.mainTabOf(id)) }, translate)
  }

  const change = async (id: string, action: ExtensionPendingAction | undefined, run: () => Promise<{ success: boolean; error?: string }>) => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(action ? { [id]: action } : {})
    setFailed(null)
    try {
      const result = await run()
      if (!result.success) {
        log.warn({ id, error: result.error }, 'Phone App action failed')
        setFailed(translate('extensions.installFailed'))
      }
    } catch (error) {
      log.warn({ id, error: String(error) }, 'Phone App action failed')
      setFailed(translate('extensions.installFailed'))
    } finally {
      inFlight.current = false
      setPending({})
    }
  }
  const install = (ref: MarketSourceRef) => void change(ref.extensionId, 'installing', () => phoneApps.installFromMarket({ ref }))
  const act = (item: MarketListItem) => {
    const id = item.manifest.id
    const state = lifecycleOf(id, item)
    if (state?.kind === 'get') install(item.ref)
    else if (state?.kind === 'update') install({ extensionId: id, version: state.version })
    else if (state?.kind === 'enable') void change(id, undefined, () => phoneApps.setEnabled(id, true))
    else if (state?.kind === 'open') {
      const kind = store.mainTabOf(id)?.kind
      if (kind) setOpened({ kind, name: localizedManifestText(item.manifest, locale).name })
    }
  }
  const error = failed ? <SettingsNote tone="danger" role="alert">{failed}</SettingsNote> : null
  const installed = detail ? store.manifests.find((manifest) => manifest.id === detail.manifest.id) : undefined

  return (
    <>
      <SegmentedTabs className="flex-wrap gap-y-1" value={tab} onChange={setTab} ariaLabel={translate('extensions.title')} items={[
        { value: 'market', label: translate('extensions.recommended'), testId: 'phone-apps-market-tab' },
        { value: 'newest', label: translate('extensions.newest'), testId: 'phone-apps-newest-tab' },
        { value: 'popular', label: translate('extensions.popular'), testId: 'phone-apps-popular-tab' },
        { value: 'all', label: translate('extensions.allApps'), testId: 'phone-apps-all-tab' },
        { value: 'installed', label: translate('extensions.tabInstalled'), testId: 'phone-apps-installed-tab' },
      ]} />
      {tab === 'installed' ? <AppsSection /> : (
        <div className={`${skin} mk phone-app-market`} data-testid="phone-app-market">
          <SearchField value={query} placeholder={translate('extensions.searchPlaceholder')} onChange={(event) => { setQuery(event.target.value); setPages(1) }} />
          {error}
          {catalog.isPending ? <ShelfSkeleton label={translate('extensions.loading')} /> : catalog.isError ? (
            <div className="mk-status" role="alert">
              {translate('extensions.marketUnavailable')}
              <Button onClick={() => void catalog.refetch()}>{translate('extensions.retry')}</Button>
            </div>
          ) : catalog.data ? (
            <AppMarketContent
              view={tab} onRetry={() => void catalog.refetch()}
              shelf={{ status: 'ready', query, errorKind: null, items: rows.slice(0, pages * MARKET_PAGE_SIZE), total: rows.length, page: pages - 1, hasMore, loadingMore: false, invalid: [], featured: catalog.data.featured, home: catalog.data.home }}
              chip={chip} onChipChange={setChip}
              query={query.trim()} hostKey="phone" api={phoneProductApi}
              lifecycleOf={lifecycleOf} installedIds={new Set(store.manifests.map((manifest) => manifest.id))}
              pending={pending} downloadPercent={{}} onOpen={setDetail} onAction={act} sentinelRef={sentinel}
            />
          ) : null}
        </div>
      )}
      {detail ? (
        <Sheet fullScreenMobile onClose={() => setDetail(null)} testId="phone-app-product" ariaLabel={localizedManifestText(detail.manifest, locale).name}>
          <div className={`${skin} phone-app-product`}>
            <UiPortalContainerProvider value={layer}>
              {error}
              <AppProductPage
                key={detail.manifest.id}
                subject={{ manifest: grantableBy(detail.manifest, PHONE_CAPABILITIES), installed: installed ? grantableBy(installed, PHONE_CAPABILITIES) : undefined, cloud: detail.cloud, installRef: detail.ref }}
                enabled={store.isEnabled(detail.manifest.id)} lifecycle={lifecycleOf(detail.manifest.id, detail)} pending={pending[detail.manifest.id]}
                locale={locale} translate={translate} api={phoneProductApi} onOpenExternal={(url) => { window.open(url, '_blank', 'noopener,noreferrer') }}
                onBack={() => setDetail(null)} onLifecycle={() => act(detail)} onInstallVersion={install}
                backgroundSupported={false}
                permissionRevocationSupported={false}
                menu={installed && !store.isPreinstalled(installed.id) ? {
                  onToggleEnabled: (on) => void change(installed.id, undefined, () => phoneApps.setEnabled(installed.id, on)),
                  ...(store.autoUpdates(installed.id) !== null ? { autoUpdate: { on: store.autoUpdates(installed.id)!, onToggle: (on: boolean) => void change(installed.id, undefined, () => phoneApps.setAutoUpdate(installed.id, on)) } } : {}),
                } : {}}
              />
            </UiPortalContainerProvider>
            <div ref={setLayer} className={`${skin} gg-session-settings-layer`} />
          </div>
        </Sheet>
      ) : null}
      {opened ? (
        <Sheet fullScreenMobile onClose={() => setOpened(null)} testId="phone-market-app-page" ariaLabel={opened.name}>
          <PaneHeader mobile divider title={opened.name} leading={<RightPanelBackButton onBack={() => setOpened(null)} />} />
          <SessionAppFrame kind={opened.kind} />
        </Sheet>
      ) : null}
    </>
  )
})
