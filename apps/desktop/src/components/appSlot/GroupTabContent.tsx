import { messageForUser } from '@/lib/userFacingError';
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { reaction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, MoreHorizontal, X } from '@/lib/icons'
import { useAuth } from '../../store/auth'
import { declaredMenuCommands, declaredToolbarCommands, runExtensionCommand } from '../../session/renderer/features/extensions/extension-commands'
import { extensionSurfaceStore, extensionTabTitle } from '../../session/renderer/features/extensions/extension-surface-store'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import type { AppOpenWithDetail } from '../../session/shared/extensions/app-runtime-protocol'
import { displayNameOf, openerAhead, openerChoice } from '../../session/shared/extensions/file-openers'
import { installPackageOf, packageKey, sharedPackagesOf, subscribeSharedPackages, type PackageCard, type SharedPackage } from '../extensionBundle/sharedPackages'
import { compareExtensionVersions, parseExtensionTabKind, type ExtensionManifest } from '../../session/shared/extensions/manifest'
import { groupUpdateFor } from '../../session/shared/extensions/app-card-state'
import { isInstallRefused } from '../../session/shared/extensions/attachment-install'
import { groupPageSlot, isFolderItem, type PanelItem } from '../../session/renderer/features/chats/chat-tabs/chat-panel-item'
import { closeChatTab, panelFull, panelTabOf, replacePanelItem, returnToOf, setPanelFull, showChatOnly } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'
import { refusedLine } from '../extensionBundle/installedHere'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { IconButton } from '../ui/IconButton'
import { DropdownMenu, menuRowClassName } from '../ui/Menu'
import { PaneHeader } from '../ui/Pane'
import { useBackLayer } from '../ui/sheetStack'
import { RightPanelBackButton } from '../chat/RightPanel'
import { platform } from '../../platform'
import { AppErrorDetails, AppErrorMark } from './AppErrorMark'
import { appsHere } from './appsHere'
import { MessageFilePreview } from '../chat/MessageFilePreview'
import { useChatFolderName } from '../chat/chatFolderName'
import { AppPeekSlot } from './AppPeekSlot'
import { ClaimedPage } from './ClaimedPage'
import { peekStore } from '../../session/renderer/features/extensions/peek-store'
import { extensionViewStore } from '../../session/renderer/features/extensions/extension-view-store'
import { ExtensionTabPane } from '../../session/renderer/features/extensions/extension-tab-pane'
import { ExtensionTabToolbar } from '../../session/renderer/features/extensions/extension-tab-toolbar'
import { PhoneAppFrame } from './PhoneAppFrame'
import { updateUnasked } from './updateUnasked'
import { useSlotMakesWay } from './useSlotMakesWay'
import { rendererLogger } from '../../lib/log'
import { appNameOf, enabledApps, rememberedOpener } from './openerChoice'

const log = rendererLogger('app-slot/group')

/**
 * An App that opens a file more specifically than anything installed: one shared in this chat (摩擦单 F15), or one of the
 * market's (161 10-15), even when Workspace already opens the file as JSON.
 */
interface Offer {
  appName: string
  from: { kind: 'shared'; card: PackageCard } | { kind: 'market'; extensionId: string; version: string }
}

/** A market App this device can install, its version for here (`appsHere.marketOffers`). */
interface MarketOffer {
  manifest: ExtensionManifest
  version: string
}

/**
 * The App not installed here (or only older) that would open this file ahead of every installed one — ranked as a tap
 * ranks (`openerAhead`), over this chat's shared packages and then the market's Apps (one shared in the chat is the
 * group's own: the market's copy of the same App is not offered beside it). An installed App is only offered if newer.
 */
function offerFor(typedName: string, shared: ReadonlyMap<string, SharedPackage>, market: readonly MarketOffer[], installed: ExtensionManifest[], all: readonly ExtensionManifest[] = installed): Offer | null {
  const notHere = (manifest: ExtensionManifest) => {
    const mine = all.find((candidate) => candidate.id === manifest.id)
    return !mine || compareExtensionVersions(mine.version, manifest.version) < 0
  }
  const sharedHere = [...shared.values()].filter((pkg) => notHere(pkg.manifest))
  const marketHere = market.filter((entry) => notHere(entry.manifest) && !shared.has(entry.manifest.id))
  const best = openerAhead(typedName, installed, [...sharedHere.map((pkg) => pkg.manifest), ...marketHere.map((entry) => entry.manifest)], 'chat')
  if (!best) return null
  const pkg = sharedHere.find((candidate) => candidate.manifest.id === best.extensionId)
  if (pkg) return { appName: appNameOf(best), from: { kind: 'shared', card: pkg.card } }
  const entry = marketHere.find((candidate) => candidate.manifest.id === best.extensionId)
  return entry ? { appName: appNameOf(best), from: { kind: 'market', extensionId: entry.manifest.id, version: entry.version } } : null
}

/** How many toolbar entries fit beside the title in a slot at its narrowest (360); the rest fold into the menu. */
const INLINE_COMMANDS = 2

/** What 「返回」 reaches from a tab, nearest last: its 上一页, and that one's, while each is still open beside the chat. */
function backChain(chatId: string, tabId: string): { tabId: string; item: PanelItem }[] {
  const chain: { tabId: string; item: PanelItem }[] = []
  for (let back = returnToOf(chatId, tabId); back; back = returnToOf(chatId, back)) {
    const tab = panelTabOf(chatId, back)
    if (!tab || tab.tabId === tabId || chain.some((entry) => entry.tabId === back)) break
    chain.unshift({ tabId: back, item: tab.item })
  }
  return chain
}

export interface GroupTabContentProps {
  chatId: string
  tabId: string
  item: PanelItem
  /** In a block, whose strip names the tab (its title, its ×): only a slim row for what belongs to the page. */
  tabbed: boolean
  /**
   * In a window of its own: the main window's App layer cannot draw there, so its page is its own webview here (as a
   * task's App tab in a window), the one left idle in the layer let go — one page running at a time.
   */
  inWindow?: boolean
  mobile: boolean
  visible?: boolean
  onForward?: (message: MessageItem) => void
  /** A page here asked to open a file (a phone frame's `files.openWith`): this tab is its 上一页. */
  onOpenWith: (detail: AppOpenWithDetail, returnTo: string) => void
}

/**
 * What one tab beside a chat shows (真源 §2.4: 群右栏槽位, 主人 09-29): the App's page in this chat, a file in the App that
 * opens it, or — no App claims it — the host's preview.
 *
 * - **Desktop**: the page lives in the session page's resident layer (extension-view-layer.tsx) — one page per App per
 *   group, which never changes group (摩擦单 F48). This element only claims it: the layer lays that page over this box.
 * - **Phone** (no Electron): the App runs right here, in an iframe of this page, which is its host (phoneAppHost.ts) — in
 *   an origin of its own (appOrigin.ts), from the phone's App store.
 *
 * Around the page, the same on both: this group's shared packages and the 「用 X 打开 · 安装」 offer (F15), the update bar
 * (F66), the App's commands, badge and error; 「返回」 to the tab whose page opened this one (owner 10-24).
 */
export const GroupTabContent = observer(function GroupTabContent({ chatId, tabId, item, tabbed, inWindow = false, mobile, visible, onForward, onOpenWith }: GroupTabContentProps) {
  const { t } = useTranslation('messaging')
  const slot = groupPageSlot(chatId, tabId)
  const folderName = useChatFolderName(chatId)
  const desktop = platform.kind === 'electron'
  const { user } = useAuth()
  const back = returnToOf(chatId, tabId)
  const backIsPanel = back !== null && panelTabOf(chatId, back) !== null
  const close = () => closeChatTab(chatId, tabId)
  const [offer, setOffer] = useState<Offer | null>(null)
  const [installingOffer, setInstallingOffer] = useState(false)
  /** Why the offered App did not install, said under the offer: E-05's `refusedLine`, or that it failed. */
  const [offerFailed, setOfferFailed] = useState<string | null>(null)
  /** The market's Apps for this device, from its cached index (`unreadable`: the market could not be read). */
  const [market, setMarket] = useState<readonly MarketOffer[] | 'unreadable' | null>(null)
  /** Under an offer the file's raw content is folded away until asked for: the App to install first, not a screen of JSON. */
  const [rawShown, setRawShown] = useState(false)
  /** This chat's newest shared package of each App (摩擦单 F15): the one shared read (`sharedPackagesOf`). */
  const [shared, setShared] = useState<{ chatId: string; packages: ReadonlyMap<string, SharedPackage> } | null>(null)
  const [sharedCue, setSharedCue] = useState(0)
  /** The App's error spelled out under the header, when the person asked (摩擦单 F63). */
  const [errorShown, setErrorShown] = useState(false)

  useEffect(() => {
    if (!appsHere || !user?.id) return undefined
    let live = true
    sharedPackagesOf(chatId, user.id).then(
      (packages) => live && setShared({ chatId, packages }),
      () => live && setShared({ chatId, packages: new Map() }),
    )
    return () => {
      live = false
    }
  }, [chatId, user?.id, sharedCue])

  // The data file can be in the group before its App's card: the card goes out once the App passed its check (摩擦单 F15,
  // L5 S1 — ~2 s). When that card arrives the chat's list is read again, and a file already open gets its offer then.
  useEffect(() => subscribeSharedPackages((changed) => { if (changed === chatId) setSharedCue((cue) => cue + 1) }), [chatId])

  // Read the index in hand (161 10-15), never refresh it for a file: main's cache on the desktop, the phone's own.
  const typedName = item.kind ? item.typedName ?? null : null
  useEffect(() => {
    setMarket(null)
    if (!appsHere || !typedName) return undefined
    let live = true
    appsHere.marketOffers().then(
      (answer) => live && setMarket(answer.success && answer.data ? answer.data : 'unreadable'),
      () => live && setMarket('unreadable'),
    )
    return () => {
      live = false
    }
  }, [typedName])

  // Offer an App ahead of anything installed (`openerAhead`): shared here first (F15), else the market's (161 10-15).
  useEffect(() => {
    const fromMarket = Array.isArray(market) ? market : []
    setOfferFailed(null)
    if (!appsHere || !typedName || !shared || shared.chatId !== chatId) {
      setOffer(null)
      return undefined
    }
    return reaction(
      () => ({ installed: enabledApps(), all: installedExtensionsStore.manifests.slice() }),
      ({ installed, all }) => setOffer(offerFor(typedName, shared.packages, fromMarket, installed, all)),
      { fireImmediately: true },
    )
  }, [typedName, market, chatId, shared])
  useEffect(() => setRawShown(false), [item.itemId, chatId])
  /** A file opened before this chat's packages were read: held back for that moment, so an offer is not preceded by its raw JSON. */
  const offerUnknown = appsHere !== null && !!item.kind && !!item.itemId && (!shared || shared.chatId !== chatId)
  /** The open file's raw page folds under an offer for it (not under one for a file nobody here opens). */
  const offerFolds = offer !== null && !rawShown

  // An App installed while a file of its kind is open here takes that file over, in place — from the offer above or from
  // a card in the chat alike (摩擦单 F15, L5 S1): the same tab, now in that App.
  useEffect(() => {
    const typed = item.typedName
    if (!appsHere || !typed || !item.itemId) return undefined
    return reaction(enabledApps, (manifests) => {
      const choice = openerChoice(typed, manifests, 'chat', rememberedOpener)
      if (choice.kind === 'one' && choice.candidate.tabKind !== item.kind) {
        replacePanelItem(chatId, tabId, { kind: choice.candidate.tabKind, itemId: item.itemId, typedName: typed, title: displayNameOf(item.fileName ?? item.title, choice.candidate.suffix), fileName: item.fileName })
      }
    })
  }, [chatId, tabId, item])

  // On the phone the tab is a whole page (#6815): its way out is the top-left back, and the back key does the same.
  useBackLayer(close, mobile)
  // An App took the person to this chat (`gugu.compose`): out from over the chat, so what it pointed at is seen.
  useSlotMakesWay(chatId, () => {
    if (mobile) showChatOnly(chatId)
    else if (panelFull(chatId, tabId)) setPanelFull(chatId, tabId, false)
  })

  const installOffer = async () => {
    if (!offer || !appsHere) return
    setInstallingOffer(true)
    setOfferFailed(null)
    try {
      // The same install as the card's and the Apps page's: consent in place when it asks for anything (摩擦单 F6).
      const result =
        offer.from.kind === 'shared'
          ? await appsHere.installAttachment({ ...installPackageOf(offer.from.card), chatId })
          : await appsHere.installFromMarket({ ref: { extensionId: offer.from.extensionId, version: offer.from.version }, chatId })
      if (!result.success) {
        log.error({ appName: offer.appName, from: offer.from.kind, error: result.error }, 'the App offered for a file did not install')
        setOfferFailed(messageForUser(result.error))
        return
      }
      if (result.data && isInstallRefused(result.data)) {
        log.info({ appName: offer.appName, reason: result.data.reason }, 'the App offered for a file was refused')
        setOfferFailed(refusedLine(result.data))
        return
      }
      if (!result.data?.installed) return
      setOffer(null)
    } catch (error) {
      log.error({ error }, 'the App offered for a file did not install')
      setOfferFailed(messageForUser(error))
    } finally {
      setInstallingOffer(false)
    }
  }

  const kind = item.kind
  // 摩擦单 F66 (S17): the App on screen is older here than a package of it shared in this group. From its publisher and
  // asking nothing new, it updates itself (`updateUnasked`) and the page reloads in place; otherwise — it asks for more,
  // or someone else sent it — a bar under the header says so, never in the way, and one click asks the person.
  const shownApp = kind ? parseExtensionTabKind(kind)?.extensionId ?? null : null
  // #7050 左栏「退出」了这里开着的 App:它的这一枚跟着关掉。
  useEffect(() => {
    if (!shownApp) return undefined
    return reaction(
      () => installedExtensionsStore.quit.includes(shownApp),
      (quit) => { if (quit) closeChatTab(chatId, tabId) },
    )
  }, [shownApp, chatId, tabId])
  const sharedHere = shownApp && shared && shared.chatId === chatId ? shared.packages.get(shownApp) : undefined
  const shownVersion = shownApp ? installedExtensionsStore.manifestFor(shownApp)?.version : undefined
  const update =
    appsHere && shownApp && sharedHere
      ? groupUpdateFor(shownVersion === undefined ? null : { version: shownVersion, origin: installedExtensionsStore.origins[shownApp] }, sharedHere)
      : null
  /** The package an update without a click was refused for: the bar is for that one. */
  const [held, setHeld] = useState<string | null>(null)
  const updateKey = update ? packageKey(update.card) : null
  useEffect(() => {
    if (!update || !updateKey) return undefined
    let live = true
    void updateUnasked(installPackageOf(update.card)).then((installed) => live && !installed && setHeld(updateKey))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateKey is the package's identity
  }, [updateKey])
  const [updating, setUpdating] = useState(false)
  /** Why the bar's update did not go in, said under it: E-05's `refusedLine`, or that it failed. */
  const [updateFailed, setUpdateFailed] = useState<string | null>(null)
  const installUpdate = async (pkg: SharedPackage) => {
    if (!appsHere) return
    setUpdating(true)
    setUpdateFailed(null)
    try {
      const result = await appsHere.installAttachment({ ...installPackageOf(pkg.card), chatId })
      if (!result.success || !result.data) {
        log.error({ package: packageKey(pkg.card), error: result.error }, "the group's App update did not install")
        setUpdateFailed(messageForUser(result.error))
      } else if (isInstallRefused(result.data)) {
        log.info({ package: packageKey(pkg.card), reason: result.data.reason }, "the group's App update was refused")
        setUpdateFailed(refusedLine(result.data))
      }
    } catch (error) {
      log.error({ error }, "the group's App update did not install")
      setUpdateFailed(messageForUser(error))
    } finally {
      setUpdating(false)
    }
  }
  /** The phone's visible frame takes commands itself (set by it). */
  const frameCommand = useRef<((commandId: string) => void) | null>(null)
  const runCommand = (commandId: string) => {
    // On the desktop the page drawing this tab is found as a task tab's is (the layer notes its webContents under the slot).
    if (desktop) runExtensionCommand(null, slot, commandId)
    else {
      frameCommand.current?.(commandId)
    }
  }
  // The phone's page header draws them; in a strip the task's command bar does, in a window the page's own pane (ExtensionTabPane).
  const toolbar = kind && !inWindow ? declaredToolbarCommands(kind) : []
  const inline = toolbar.slice(0, INLINE_COMMANDS)
  const folded = [...toolbar.slice(INLINE_COMMANDS), ...(kind && !inWindow ? declaredMenuCommands(kind) : [])]
  const shown = extensionSurfaceStore.said(null, slot)
  const windowApp = inWindow && kind ? parseExtensionTabKind(kind)?.extensionId ?? null : null
  useEffect(() => {
    if (windowApp && kind && !item.itemId) extensionViewStore.forgetIdle(kind)
  }, [windowApp, kind, item.itemId])
  // A session opened beside the page needs the room: the tab fills the block while it is up, and back after (170 10-19 ③).
  const peekingSession = peekStore.of(null, slot)?.kind === 'session'
  const widenedFor = useRef(false)
  useEffect(() => {
    if (!tabbed || mobile) return
    if (peekingSession && !panelFull(chatId, tabId)) {
      widenedFor.current = true
      setPanelFull(chatId, tabId, true)
    } else if (!peekingSession && widenedFor.current) {
      widenedFor.current = false
      if (panelFull(chatId, tabId)) setPanelFull(chatId, tabId, false)
    }
  }, [peekingSession, tabbed, mobile, chatId, tabId])
  const heading = extensionTabTitle(shown, isFolderItem(item) ? folderName : kind ? installedExtensionsStore.tabTitle(kind) ?? item.title : item.title, item.itemId ? { name: item.title, path: item.fileName ?? item.title } : undefined)
  const badge = shown.badge
  const hasBadge = badge !== null && badge !== ''
  const appError = shown.error
  const backButton = backIsPanel ? (
    <IconButton size={mobile ? 'lg' : 'sm'} data-testid="group-app-slot-back" onClick={close} aria-label={t('chatArea.openWith.back')}>
      <ChevronLeft />
    </IconButton>
  ) : null
  const closeButton = <IconButton size={mobile ? 'lg' : 'sm'} data-testid="group-app-slot-close" onClick={close} aria-label={t('common.close')}><X /></IconButton>
  const commands = (
    <>
      {inline.map((command) => (
        <Button key={command.id} size="sm" variant="ghost" data-command={command.id} onClick={() => runCommand(command.id)}>
          {command.title}
        </Button>
      ))}
      {folded.length > 0 ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="gg-ghost" data-testid="group-app-slot-more" aria-label={t('chatArea.openWith.more')}>
            <MoreHorizontal size={16} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            {folded.map((command) => (
              <DropdownMenu.Item key={command.id} className={menuRowClassName} data-command={command.id} onClick={() => runCommand(command.id)}>
                {command.title}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      ) : null}
    </>
  )
  const marks = (
    <>
      {hasBadge ? <Chip data-testid="group-app-slot-badge">{badge}</Chip> : null}
      {appError ? <AppErrorMark error={appError} onToggle={() => setErrorShown((open) => !open)} testId="group-app-slot-error" /> : null}
    </>
  )
  const frames = [...backChain(chatId, tabId), ...(offerUnknown || offerFolds ? [] : [{ tabId, item }])].filter((entry) => entry.item.kind !== null)
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col" data-testid="group-app-slot" data-app-kind={kind} data-chat-tab={tabId}>
      {/* 页签里(owner 10-26 选 A):页签就是标题、×、角标和出错,最大化长在页签上;App 声明的按钮同任务页一条(没声明就没有这一行)。 */}
      {item.file ? null : tabbed ? (kind && !inWindow ? <ExtensionTabToolbar tabKind={kind} sessionId={null} tabId={slot} /> : null) : <PaneHeader
        title={<span title={heading.tooltip}>{heading.label}</span>}
        divider
        // 手机上是一整页:页头和别的手机页同一档(peek 盖上来时也是这一档,一个页头)。
        {...(mobile ? { mobile: true } : {})}
        leading={backButton ?? (mobile ? <RightPanelBackButton onBack={close} /> : undefined)}
        actions={
          <>
            {commands}
            {mobile ? null : closeButton}
          </>
        }
      >
        {marks}
      </PaneHeader>}
      {appError && errorShown ? <AppErrorDetails error={appError} testId="group-app-slot-error-details" /> : null}
      {update && held === updateKey ? (
        <div
          className="flex items-center gap-2 border-b border-[var(--border)] !px-3 !py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]"
          data-testid="group-app-slot-update"
          data-version={update.manifest.version}
        >
          <span className="min-w-0 flex-1 truncate">{t('chatArea.openWith.updateHere', { version: update.manifest.version })}</span>
          <Button size="sm" variant="ghost" data-testid="group-app-slot-update-install" disabled={updating} onClick={() => void installUpdate(update)}>
            {t('chatArea.openWith.update')}
          </Button>
        </div>
      ) : null}
      {update && held === updateKey && updateFailed ? (
        <div className="border-b border-[var(--border)] !px-3 !py-1 text-[length:var(--font-caption)] text-[var(--text-error)]" data-testid="group-app-slot-update-failed">
          {t('chatArea.openWith.installFailed')}<br />{updateFailed}
        </div>
      ) : null}
      {offer ? (
        <div className="flex flex-col items-start gap-2 border-b border-[var(--border)] !p-4" data-testid="group-app-slot-offer" data-offer-from={offer.from.kind}>
          <div className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">{t('chatArea.openWith.offer', { name: offer.appName })}</div>
          <div className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">
            {t('chatArea.openWith.offerWhy', { name: offer.appName })}
            {offer.from.kind === 'market' ? ' ' + t('chatArea.openWith.offerFromMarket') : null}
          </div>
          {offerFailed ? (
            <div className="text-[length:var(--font-caption)] text-[var(--text-error)]" data-testid="group-app-slot-offer-failed">
              {t('chatArea.openWith.installFailed')}<br />{offerFailed}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" data-testid="group-app-slot-offer-install" disabled={installingOffer} onClick={() => void installOffer()}>
              {t('chatArea.openWith.install')}
            </Button>
            <Button size="sm" variant="ghost" data-testid="group-app-slot-offer-raw" onClick={() => setRawShown((open) => !open)}>
              {rawShown ? t('chatArea.openWith.hideRaw') : t('chatArea.openWith.showRaw')}
            </Button>
          </div>
        </div>
      ) : null}
      {/* What the page on screen opens beside it (G1): over it here, the page kept for the way back. */}
      <AppPeekSlot sessionId={null} tabId={slot} narrow={mobile}>
        {item.file && (!mobile || visible !== false) ? <MessageFilePreview fill tabbed={tabbed} mobile={mobile} message={item.message} onForward={onForward} file={{ kind: 'file', document: item.file.document, fileName: item.fileName ?? item.title, mimeType: item.file.contentType, sizeBytes: item.file.size, source: { kind: 'item', itemId: item.itemId!, version: item.file.version } }} onBack={mobile || backIsPanel ? close : undefined} onClose={close} /> : null}
        {desktop ? item.file || !kind ? null : (
          offerUnknown || offerFolds ? (
            <div className="min-h-0 flex-1" data-testid="group-app-slot-raw-folded" />
          ) : windowApp ? (
            <div className="min-h-0 flex-1"><ExtensionTabPane extensionId={windowApp} tabKind={kind} sessionId={null} tabId={slot} chatId={chatId} {...(item.itemId ? { itemId: item.itemId } : {})} /></div>
          ) : (
            <ClaimedPage slotId={slot} chatId={chatId} kind={kind} itemId={item.itemId} takeOpening={item.takeOpening} />
          )
        ) : (
          <>
            {/* Under an offer the file's raw page waits, as on the desktop: the App to install first (摩擦单 F15). */}
            {offerUnknown || offerFolds ? <div className="min-h-0 flex-1" data-testid="group-app-slot-raw-folded" /> : null}
            {/* What 「返回」 reaches stays as it was, hidden (G2) — a frame, unlike a desktop page, is not kept elsewhere. */}
            {frames.map((entry) => (
              <PhoneAppFrame
                key={`${entry.item.kind}:${entry.item.itemId}:${entry.tabId}`}
                chatId={chatId}
                kind={entry.item.kind!}
                itemId={entry.item.itemId}
                hidden={entry.tabId !== tabId}
                onOpenWith={(detail) => onOpenWith(detail, tabId)}
                tabId={groupPageSlot(chatId, entry.tabId)}
                commandRef={entry.tabId === tabId ? frameCommand : undefined}
                testId="group-app-frame"
                missingTestId="group-app-slot-missing"
              />
            ))}
          </>
        )}
      </AppPeekSlot>
    </div>
  )
})
