import { useEffect, useState, type RefObject } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { Pin, PinOff, X } from '@/lib/icons'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { RailAppIcon } from '../RailAppIcon'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { Sheet } from '../ui/Sheet'
import { menuSurfaceClassName } from '../ui/Menu'
import { openApp } from '../appSlot/useOpenApp'
import { appsHere } from '../appSlot/appsHere'
import type { useChatAppPins } from './useChatAppPins'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'

/**
 * The Apps this group can open: those with a page of their own, and those with a file in this group's folder they open —
 * an agent's group game is the second kind and opens on its file, as its card's 「Open」 (5-minute game ①). An App that only
 * opens files and has none here would open nothing, so it is not listed.
 */
function useGroupApps(chatId: string) {
  const all = installedExtensionsStore.chatOpenableApps
  const fileOnly = all.filter((app) => !installedExtensionsStore.mainTabOf(app.extensionId)).map((app) => app.extensionId).join('\n')
  const [withFiles, setWithFiles] = useState<{ chatId: string; ids: ReadonlySet<string> }>({ chatId, ids: new Set() })
  useEffect(() => {
    let live = true
    const ids = fileOnly ? fileOnly.split('\n') : []
    void Promise.all(ids.map(async (extensionId) => {
      const files = await appsHere?.groupFilesOpenedBy({ chatId, extensionId })
      return files?.success && (files.data?.length ?? 0) > 0 ? [extensionId] : []
    })).then((found) => { if (live) setWithFiles({ chatId, ids: new Set(found.flat()) }) })
    return () => { live = false }
  }, [chatId, fileOnly])
  return all.filter((app) => installedExtensionsStore.mainTabOf(app.extensionId) || (withFiles.chatId === chatId && withFiles.ids.has(app.extensionId)))
}

export const GroupAppsPicker = observer(function GroupAppsPicker({ chatId, pins, mobile, anchor, onClose }: {
  chatId: string
  pins: ReturnType<typeof useChatAppPins>
  mobile?: boolean
  anchor: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const apps = useGroupApps(chatId)
  const body = (
    <div data-testid={AUTOMATION_TEST_IDS.groupAppsPicker} className="p-2">
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <h2 className="flex-1 text-[length:var(--font-body)] font-medium">{t('header.groupApps')}</h2>
        <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t('header.personalPins')}</span>
        <IconButton size="sm" aria-label={t('common.close')} onClick={onClose}><X /></IconButton>
      </div>
      {pins.error && <div role="alert" className="px-2 pb-2 text-[length:var(--font-caption)] text-[var(--text-error)]">{t('header.appPinsLoadFailed')} <Button size="sm" variant="ghost" onClick={pins.retry}>{t('common.retry')}</Button></div>}
      {apps.map((app) => {
        const pinned = pins.ids.includes(app.extensionId)
        const pinLabel = t(pinned ? 'header.unpinGroupApp' : 'header.pinGroupApp', { name: app.name })
        return (
          <div key={app.extensionId} data-app-id={app.extensionId} className="flex items-center gap-1">
            <Button variant="ghost" className="min-w-0 flex-1 justify-start" data-testid="group-apps-open" onClick={() => { openApp(app.extensionId, chatId); onClose() }}>
              <RailAppIcon app={app} className="gg-sidebar-launch-icon" /><span className="truncate">{app.name}</span>
            </Button>
            <IconButton data-testid={AUTOMATION_TEST_IDS.groupAppsPin} aria-label={pinLabel} title={pinLabel} aria-pressed={pinned} on={pinned || undefined} disabled={!pins.ready || pins.saving} onClick={() => pins.set({ appId: app.extensionId, pinned: !pinned })}>
              {pinned ? <PinOff /> : <Pin />}
            </IconButton>
          </div>
        )
      })}
      {apps.length === 0 && <p className="px-2 py-3 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t(installedExtensionsStore.isLoaded ? 'header.noGroupApps' : 'common.loading')}</p>}
    </div>
  )
  return mobile ? <Sheet onClose={onClose} finalFocus={anchor} mobileFitContent ariaLabel={t('header.groupApps')}>{body}</Sheet> : (
    <Popover.Portal><Popover.Positioner anchor={anchor} side="bottom" align="end" sideOffset={4} collisionPadding={8}>
      <Popover.Popup aria-label={t('header.groupApps')} finalFocus={anchor} className={`${menuSurfaceClassName} max-h-[70vh] w-[min(320px,calc(100vw-16px))] overflow-y-auto`}>{body}</Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  )
})
