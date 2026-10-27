import { followLink } from '../../lib/guguLinks'
import { ResourceMenu } from '../ResourceMenu'
import { comparer, reaction } from 'mobx'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'
import { localizedManifestText } from '../../session/shared/extensions/catalog'
import { compareExtensionVersions, type ExtensionManifest } from '../../session/shared/extensions/manifest'
import type { MarketVersionHistoryEntry } from '../../session/shared/extensions/market'
import { phoneApps } from '../appSlot/phoneApps'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow, Toggle } from './SettingsPrimitives'

/**
 * 「App」 on the phone (L9): the Apps installed on it — from cards in chats and from the market — and the way to remove one.
 * The ones gugu ships are not listed — they cannot be removed. Uninstalling says what goes and what stays, in the sentence
 * the desktop's uninstall says it (摩擦单 F67): its files, what it kept here, and its storage go; the group's files stay.
 * A market App with a newer version for this phone says so and is updated from here (161 10-15: else its fixes never
 * reach the phone). Since owner 10-19 it also updates by itself, as on the desktop (phoneApps `autoUpdate`); its 「版本」 sheet
 * holds its 「自动更新」 switch and every version, any of which can be installed (an older one switches 「自动更新」 off). Each one has its switch, as on the desktop (161 10-16): off, it is
 * not opened, not offered for a file, not in a menu; its files, data and what it was allowed stay (phoneApps `setEnabled`).
 * An App with a page of its own opens it from its row, over the whole screen — in no chat, as the desktop's rail opens it.
 */
/**
 * The version the market offers this phone for each App installed here from it, and the ones no longer in the market (owner
 * 10-19, as the desktop says); null when the market was not reached.
 */
async function offeredVersions(): Promise<{ updates: Record<string, string>; gone: string[] } | null> {
  const result = await phoneApps.marketUpdates()
  return result.success
    ? { updates: Object.fromEntries(Object.entries(result.data.updates).map(([id, update]) => [id, update.version])), gone: result.data.gone ?? [] }
    : null
}

export function AppsSection() {
  const { t, i18n } = useTranslation('main')
  const { t: tm } = useTranslation('messaging')
  const titleId = useId()
  const [apps, setApps] = useState<{ manifest: ExtensionManifest; from: string | null; enabled: boolean; autoUpdate: boolean | null; page: string | null }[]>([])
  /** The App whose 「版本」 sheet is open, and its versions as the market lists them for this phone (null: not read yet / unreadable). */
  const [versionsOf, setVersionsOf] = useState<{ id: string; name: string } | null>(null)
  const [history, setHistory] = useState<MarketVersionHistoryEntry[] | 'error' | null>(null)
  // Installed, but not runnable by this build (phoneApps `tell`): the row's title is its id, its line the refusal as it
  // is (not the id again — L3 phone ②, 125 10-06), and it is still removable: any App the phone cannot read must be.
  const [unusable, setUnusable] = useState<{ id: string; reason: string }[]>([])
  const [asking, setAsking] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<{ action: 'uninstall' | 'update' | 'switch'; error: string } | null>(null)
  /** What the market offers for the Apps installed here from it, by id (none: up to date, or not from the market). */
  const [updates, setUpdates] = useState<Record<string, string>>({})
  const [gone, setGone] = useState<string[]>([])
  const offer = (offered: { updates: Record<string, string>; gone: string[] } | null) => {
    if (!offered) return
    setUpdates(offered.updates)
    setGone(offered.gone)
  }

  useEffect(() => {
    // 「更新到 vX」 from the index in hand at once; the download site is asked behind it, and when the index it brings is
    // another, the buttons are read again from that one (market-snapshot.ts) — none, if nothing came.
    const read = () =>
      void phoneApps.ready().then(offeredVersions).then((offered) => {
        if (!offered) return
        setUpdates(offered.updates)
        setGone(offered.gone)
      }, () => undefined)
    read()
    const offRefreshed = phoneApps.market.onRefreshed((refreshed) => refreshed.outcome === 'changed' && read())
    // What is installed changed (an App updated by itself, owner 10-19): what the market has to say about it is read again.
    const offInstalled = reaction(() => installedExtensionsStore.manifests.map((manifest) => `${manifest.id}@${manifest.version}`).join(' '), read)
    void phoneApps.market.refresh()
    const off = reaction(
      () => installedExtensionsStore.invalid.map((entry) => ({ id: entry.dirName, reason: entry.reason })),
      setUnusable,
      { fireImmediately: true, equals: comparer.structural },
    )
    const offApps = reaction(
      () =>
        installedExtensionsStore.manifests
          .filter((manifest) => !installedExtensionsStore.isPreinstalled(manifest.id))
          .map((manifest) => ({
            manifest,
            from: installedExtensionsStore.publishers[manifest.id]?.name ?? null,
            enabled: installedExtensionsStore.isEnabled(manifest.id),
            autoUpdate: installedExtensionsStore.autoUpdates(manifest.id),
            page: installedExtensionsStore.mainTabOf(manifest.id)?.kind ?? null,
          })),
      setApps,
      { fireImmediately: true, equals: comparer.structural },
    )
    return () => {
      off()
      offApps()
      offRefreshed()
      offInstalled()
    }
  }, [])

  const uninstall = async (id: string) => {
    setBusy(true)
    const result = await phoneApps.uninstall(id)
    setBusy(false)
    setAsking(null)
    setFailed(result.success ? null : { action: 'uninstall', error: result.error })
  }
  /** The market's version for this phone, installed the one way: asked here only when it asks for more. */
  const update = async (id: string, version: string) => {
    setBusy(true)
    const result = await phoneApps.installFromMarket({ ref: { extensionId: id, version } })
    setBusy(false)
    setFailed(result.success ? null : { action: 'update', error: result.error })
    offer(result.success && result.data.installed ? await offeredVersions() : null)
  }
  const openVersions = (app: { id: string; name: string }) => {
    setVersionsOf(app)
    setHistory(null)
    void phoneApps.market.history(app.id).then(setHistory, () => setHistory('error'))
  }
  /** One version from the 「版本」 sheet, installed the one way (an older one than offered switches 「自动更新」 off there). */
  const installVersion = async (id: string, version: string) => {
    setBusy(true)
    const result = await phoneApps.installFromMarket({ ref: { extensionId: id, version } })
    setBusy(false)
    setFailed(result.success ? null : { action: 'update', error: result.error })
    offer(await offeredVersions())
  }
  const setAutoUpdate = async (id: string, on: boolean) => {
    setBusy(true)
    const result = await phoneApps.setAutoUpdate(id, on)
    setBusy(false)
    setFailed(result.success ? null : { action: 'switch', error: result.error })
  }
  const setEnabled = async (id: string, enabled: boolean) => {
    setBusy(true)
    const result = await phoneApps.setEnabled(id, enabled)
    setBusy(false)
    setFailed(result.success ? null : { action: 'switch', error: result.error })
  }
  const uninstallButton = (app: { id: string; name: string }) => (
    <Button size="sm" variant="ghost" data-testid="settings-apps-uninstall" onClick={() => setAsking(app)}>
      {translateSessionMessage('extensions.uninstallAction')}
    </Button>
  )

  return (
    <SettingsPage data-testid="settings-apps">
      <SettingsGroup note={t('settings.apps.intro')}>
        {apps.length === 0 && unusable.length === 0 ? (
          <SettingsRow description={t('settings.apps.empty')} data-testid="settings-apps-empty" />
        ) : (
          <>
            {apps.map(({ manifest, from, enabled, page, autoUpdate }) => {
              // 名字跟界面语言走,和电脑上 App 页同一个挑法(manifest 的 localized)。
              const name = localizedManifestText(manifest, i18n.language).name
              return (
                <ResourceMenu key={manifest.id} resource={{ kind: 'app', target: { kind: 'app-detail', extensionId: manifest.id } }}><SettingsRow
                  data-app-id={manifest.id}
                  // 行尾最多 打开 / 更新到 / 开关 / 卸载:手机上换到说明下面,说明不被挤成一窄条。
                  stack
                  title={name}
                  description={[
                    phoneApps.originOf(manifest.id) === 'market'
                      ? t('settings.apps.fromMarket', { version: manifest.version })
                      : t('settings.apps.from', { version: manifest.version, name: from ?? '—' }),
                    ...(enabled ? [] : [translateSessionMessage('extensions.switchedOff')]),
                    ...(gone.includes(manifest.id) ? [translateSessionMessage('extensions.rowGone')] : []),
                  ].join(' · ')}
                  control={
                    <div className="flex items-center gap-1">
                      {page && enabled ? (
                        <Button size="sm" variant="ghost" data-testid="settings-apps-open" onClick={() => void followLink({ kind: 'app', extensionId: manifest.id, tab: page.slice(manifest.id.length + 1), path: '', query: {}, place: null })}>
                          {t('settings.apps.open')}
                        </Button>
                      ) : null}
                      {autoUpdate !== null ? (
                        <Button size="sm" variant="ghost" data-testid="settings-apps-versions" onClick={() => openVersions({ id: manifest.id, name })}>
                          {translateSessionMessage('extensions.versions')}
                        </Button>
                      ) : null}
                      {updates[manifest.id] ? (
                        <Button size="sm" data-testid="settings-apps-update" disabled={busy} onClick={() => void update(manifest.id, updates[manifest.id]!)}>
                          {t('settings.apps.updateTo', { version: updates[manifest.id] })}
                        </Button>
                      ) : null}
                      <span data-testid="settings-apps-switch" data-enabled={enabled ? 'true' : 'false'} className="inline-flex">
                        <Toggle
                          checked={enabled}
                          onChange={(next) => void setEnabled(manifest.id, next)}
                          ariaLabel={translateSessionMessage('extensions.switchLabel', { name })}
                        />
                      </span>
                      {uninstallButton({ id: manifest.id, name })}
                    </div>
                  }
                /></ResourceMenu>
              )
            })}
            {unusable.map(({ id, reason }) => (
              <SettingsRow
                key={id}
                data-app-id={id}
                data-testid="settings-apps-unusable"
                title={id}
                description={reason}
                control={uninstallButton({ id, name: id })}
              />
            ))}
          </>
        )}
      </SettingsGroup>
      {failed ? (
        <SettingsNote tone="danger" data-testid="settings-apps-failed">
          {translateSessionMessage(failed.action === 'update' ? 'extensions.installFailed' : failed.action === 'switch' ? 'extensions.switchFailed' : 'extensions.uninstallFailed')}: {failed.error}
        </SettingsNote>
      ) : null}
      {versionsOf ? (
        <Sheet onClose={() => setVersionsOf(null)} testId="settings-apps-versions-sheet" ariaLabel={versionsOf.name}>
          <VersionsSheet
            app={versionsOf}
            installed={apps.find((app) => app.manifest.id === versionsOf.id)}
            history={history}
            busy={busy}
            locale={i18n.language}
            onAutoUpdate={(on) => void setAutoUpdate(versionsOf.id, on)}
            onInstall={(version) => void installVersion(versionsOf.id, version)}
          />
        </Sheet>
      ) : null}

      {asking ? (
        <Sheet onClose={() => setAsking(null)} testId="settings-apps-uninstall-sheet" titleId={titleId}>
          <div className="flex min-h-0 flex-1 flex-col gap-3 !p-5">
            <div id={titleId} className="text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]">
              {translateSessionMessage('extensions.uninstallConfirmTitle')}
            </div>
            <div className="text-[length:var(--font-body)] text-[var(--text-secondary)]">
              {translateSessionMessage('extensions.uninstallConfirmDescription', { name: asking.name })}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsking(null)}>
                {tm('common.cancel')}
              </Button>
              <Button data-testid="settings-apps-uninstall-confirm" disabled={busy} onClick={() => void uninstall(asking.id)}>
                {translateSessionMessage('extensions.uninstallAction')}
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </SettingsPage>
  )
}

/**
 * An App's 「版本」 on the phone: its 「自动更新」 switch, and every version as the desktop's version history lists them — the
 * installed one marked, one this phone cannot install or one withdrawn with its reason and no button.
 */
function VersionsSheet({
  app,
  installed,
  history,
  busy,
  locale,
  onAutoUpdate,
  onInstall,
}: {
  app: { id: string; name: string }
  installed: { manifest: ExtensionManifest; autoUpdate: boolean | null } | undefined
  history: MarketVersionHistoryEntry[] | 'error' | null
  busy: boolean
  locale: string
  onAutoUpdate: (on: boolean) => void
  onInstall: (version: string) => void
}) {
  const version = installed?.manifest.version
  const autoUpdate = installed?.autoUpdate ?? null
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto !p-5" data-app-id={app.id}>
      <div className="text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]">
        {app.name} · {translateSessionMessage('extensions.detailVersionHistory')}
      </div>
      {autoUpdate !== null ? (
        <SettingsGroup>
          <SettingsRow
            title={translateSessionMessage('extensions.autoUpdate')}
            // Touch has no hover: what installing an older version does is said here, not on its button.
            description={autoUpdate ? translateSessionMessage('extensions.pinHint') : version ? translateSessionMessage('extensions.pinnedAt', { version }) : undefined}
            control={
              <span data-testid="settings-apps-auto-update" data-on={autoUpdate ? 'true' : 'false'} className="inline-flex">
                <Toggle checked={autoUpdate} onChange={onAutoUpdate} ariaLabel={translateSessionMessage('extensions.autoUpdate')} />
              </span>
            }
          />
        </SettingsGroup>
      ) : null}
      {/* 行放进卡片,和设置页里的行同一种排法(裸放的行没有卡片可对齐,看着比标题缩进一截)。 */}
      <SettingsGroup>
        {history === null ? (
          <SettingsRow description={translateSessionMessage('extensions.loading')} />
        ) : history === 'error' ? (
          <SettingsRow description={translateSessionMessage('extensions.historyUnavailable')} />
        ) : history.length === 0 ? (
          <SettingsRow description={translateSessionMessage('extensions.historyNone')} />
        ) : (
          history.map((entry) => {
            const firstLine = (entry.releaseNotes.split(/\r?\n/).find((line) => line.trim() !== '') ?? '').trim().replace(/^(?:[-*+]|\d+[.)]|#{1,6})\s+/, '')
            const reason = entry.yanked
              ? translateSessionMessage('extensions.historyYanked', { note: entry.yanked.reason })
              : entry.platformRefusal
                ? translateSessionMessage('extensions.platformVersionUnavailable')
              : entry.compat
                ? entry.compat.reason === 'needs-newer-app'
                  ? translateSessionMessage('extensions.needsNewerApp', { version: entry.compat.minAppVersion })
                  : translateSessionMessage('extensions.needsAuthorUpdate')
                : null
            const date = new Date(entry.publishedAt).toLocaleDateString(locale)
            return (
              <SettingsRow
                key={entry.version}
                data-testid={`settings-apps-version-${entry.version}`}
                title={`v${entry.version}`}
                // 发布说明常是一整段:一行版本只给两行字,不把单子撑成一屏一版。
                description={<span className="line-clamp-2">{[date, reason ?? firstLine].filter(Boolean).join(' · ')}</span>}
                control={
                  entry.version === version ? (
                    <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{translateSessionMessage('extensions.stripThisInstalled')}</span>
                  ) : reason ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onInstall(entry.version)}
                    >
                      {version && compareExtensionVersions(entry.version, version) > 0 ? translateSessionMessage('extensions.updateAction') : translateSessionMessage('extensions.useVersion', { version: entry.version })}
                    </Button>
                  )
                }
              />
            )
          })
        )}
      </SettingsGroup>
    </div>
  )
}
