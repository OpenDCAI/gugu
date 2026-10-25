import type { RefObject } from 'react'
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
import type { useChatAppPins } from './useChatAppPins'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'

export const GroupAppsPicker = observer(function GroupAppsPicker({ chatId, pins, mobile, anchor, onClose }: {
  chatId: string
  pins: ReturnType<typeof useChatAppPins>
  mobile?: boolean
  anchor: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const apps = installedExtensionsStore.openableApps
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
