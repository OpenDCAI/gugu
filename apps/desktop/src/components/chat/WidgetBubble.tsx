import { observer } from 'mobx-react-lite'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { parseWidgetMessage, type WidgetMessage } from '@gugu/core/shared/ui/widgetModels'
import { platform } from '../../platform'
import { appsHere } from '../appSlot/appsHere'
import { PhoneAppFrame } from '../appSlot/PhoneAppFrame'
import { Button } from '../ui/Button'
import { APP_OPEN_WITH_EVENT } from '../../session/shared/extensions/app-runtime-protocol'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { isInstallRefused } from '../../session/shared/extensions/attachment-install'
import { refusedLine } from '../extensionBundle/installedHere'
import { ExtensionPage } from '../../session/renderer/features/extensions/extension-view-layer'
import { useConversationVisibility } from './useConversationVisibility'
import { useAuth } from '../../store/auth'
import { messageForUser } from '../../lib/userFacingError'
import { rendererLogger } from '../../lib/log'
import { installPackageOf, sharedPackagesOf, subscribeSharedPackages, type SharedPackage } from '../extensionBundle/sharedPackages'
import { availableInstallOffers, widgetInstallOffer, type MarketOffer } from '../extensionBundle/installOffers'

const log = rendererLogger('chat/widget')

type Message = Pick<MessageItem, 'id' | 'chat_id' | 'sender_user_id' | 'content'>

export const WidgetBubble = observer(function WidgetBubble({ message }: { message: Message }) {
  const { t } = useTranslation('messaging')
  const widget = useMemo(() => parseWidgetMessage(message.content), [message.content])
  if (!widget) return <span>{t('message.widget')}</span>
  if (!installedExtensionsStore.isLoaded) return <p>{widget.text}</p>
  const manifest = installedExtensionsStore.manifestFor(widget.app)
  const tab = manifest?.contributes.tabs.find(tab => tab.name === widget.view)
  const reason = !appsHere || (manifest?.platforms && !manifest.platforms.includes(platform.kind === 'electron' ? 'desktop' : 'phone')) ? 'platform'
    : !manifest ? 'missing' : !installedExtensionsStore.isEnabled(widget.app) ? 'disabled' : !tab?.widget ? 'view' : null
  if (reason || !tab?.widget) return <WidgetUnavailable widget={widget} reason={reason ?? 'view'} chatId={message.chat_id} />
  return <WidgetView key={`${message.id}:${manifest?.version}`} message={message} widget={widget} height={widget.height ?? tab.widget.height} />
})

function WidgetView({ message, widget, height }: { message: Message; widget: WidgetMessage; height: number }) {
  const { ref, shown } = useConversationVisibility(true)
  const target = useMemo(() => ({ workspace: null, conversation: message.chat_id, tabId: `widget:${message.id}`,
    widget: { messageId: message.id, data: widget.data ?? {}, senderId: message.sender_user_id } }), [message.id, message.chat_id, message.sender_user_id, widget.data])
  const kind = `${widget.app}.${widget.view}`
  return <div className="w-[420px] max-w-full min-w-0" data-widget-bubble={message.id}>
    <div ref={ref} className="flex w-full min-w-0 overflow-hidden rounded-md" style={{ height }}>
      {shown ? platform.kind === 'electron' ? <ExtensionPage extensionId={widget.app} kind={kind} inline={target} /> : <PhoneAppFrame
        kind={kind} tabId={target.tabId} chatId={message.chat_id} widget={target.widget}
        onOpenWith={detail => window.dispatchEvent(new CustomEvent(APP_OPEN_WITH_EVENT, { detail }))}
        testId="widget-frame" missingTestId="widget-frame-missing"
      /> : null}
    </div>
    <p className="whitespace-pre-wrap break-words text-[length:var(--font-caption)] text-[var(--text-secondary)]" data-widget-text>{widget.text}</p>
  </div>
}

const WidgetUnavailable = observer(function WidgetUnavailable({ widget, reason, chatId }: { widget: WidgetMessage; reason: string; chatId: string }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { ref, shown } = useConversationVisibility(true)
  const [sources, setSources] = useState<{ chatId: string; userId: string; shared: ReadonlyMap<string, SharedPackage>; market: readonly MarketOffer[] } | null>(null)
  const [cue, setCue] = useState(0)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const canOffer = reason === 'missing' || reason === 'view'
  useEffect(() => subscribeSharedPackages(changed => { if (changed === chatId) setCue(cue => cue + 1) }), [chatId])
  useEffect(() => {
    setSources(null)
    setError('')
    if (!shown || !canOffer || !appsHere || !user?.id) return
    let live = true
    void Promise.all([
      sharedPackagesOf(chatId, user.id).catch(error => {
        log.warn({ error: messageForUser(error), chatId }, 'widget App packages could not be read')
        return new Map<string, SharedPackage>()
      }),
      appsHere.marketOffers().then(result => {
        if (live && !result.success) setError(messageForUser(result.error))
        return result.data ?? []
      }, error => { if (live) setError(messageForUser(error)); return [] }),
    ]).then(([shared, market]) => { if (live) setSources({ chatId, userId: user.id, shared, market }) })
    return () => { live = false }
  }, [shown, canOffer, chatId, user?.id, cue])
  const offer = canOffer && sources?.chatId === chatId && sources.userId === user?.id
    ? widgetInstallOffer(availableInstallOffers(sources.shared, sources.market, installedExtensionsStore.manifests, installedExtensionsStore.origins),
      widget.app, widget.view, platform.kind === 'electron' ? 'desktop' : 'phone') : null
  const install = async () => {
    if (!appsHere || !offer) return
    setInstalling(true)
    setError('')
    try {
      const result = offer.from.kind === 'shared'
        ? await appsHere.installAttachment({ ...installPackageOf(offer.from.card), chatId })
        : await appsHere.installFromMarket({ ref: { extensionId: offer.from.extensionId, version: offer.from.version }, chatId })
      if (!result.success) throw new Error(result.error)
      if (result.data && isInstallRefused(result.data)) setError(refusedLine(result.data))
    } catch (error) { setError(messageForUser(error)) }
    finally { setInstalling(false) }
  }
  return <div ref={ref} className="max-w-full min-w-0">
    <p className="whitespace-pre-wrap break-words">{widget.text}</p>
    <p className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t(`message.widgetUnavailable.${reason}`)}{' '}
      {offer ? <Button size="sm" variant="ghost" disabled={installing} onClick={() => void install()} data-widget-install>{t('chatArea.openWith.install')}</Button> : null}
    </p>
    {error ? <p role="alert">{error}</p> : null}
  </div>
})
