import type { MessageItem } from '@gugu/core/shared/types/chat'
import { reaction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, Maximize2, Minimize2, MoreHorizontal, X } from '@/lib/icons'
import { useAuth } from '../../store/auth'
import { declaredMenuCommands, declaredToolbarCommands } from '../../session/renderer/features/extensions/extension-commands'
import { extensionSurfaceStore, extensionTabTitle } from '../../session/renderer/features/extensions/extension-surface-store'
import { installedExtensionsStore, WORKSPACE_APP_ID } from '../../session/renderer/features/extensions/installed-extensions-store'
import {
  APP_OPEN_WITH_EVENT,
  APP_SLOT_EVENT,
  type AppOpenWithDetail,
  type AppSlotEventDetail,
} from '../../session/shared/extensions/app-runtime-protocol'
import { displayNameOf, openerAhead, openerChoice, openWithKey, type FileOpenerCandidate } from '../../session/shared/extensions/file-openers'
import { localizedManifestText } from '../../session/shared/extensions/catalog'
import { installPackageOf, packageKey, sharedPackagesOf, subscribeSharedPackages, type PackageCard, type SharedPackage } from '../extensionBundle/sharedPackages'
import { compareExtensionVersions, parseExtensionTabKind, type ExtensionManifest } from '../../session/shared/extensions/manifest'
import { groupUpdateFor } from '../../session/shared/extensions/app-card-state'
import { isInstallRefused } from '../../session/shared/extensions/attachment-install'
import { refusedLine } from '../extensionBundle/installedHere'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { IconButton } from '../ui/IconButton'
import { DropdownMenu, menuRowClassName } from '../ui/Menu'
import { PaneHeader } from '../ui/Pane'
import { useBackLayer } from '../ui/sheetStack'
import { RightPanelBackButton } from '../chat/RightPanel'
import { useMobileShell } from '../../hooks/useMobileShell'
import { platform } from '../../platform'
import { AppErrorDetails, AppErrorMark } from './AppErrorMark'
import { appsHere } from './appsHere'
import { MessageFilePreview } from '../chat/MessageFilePreview'
import { useChatFolderName } from '../chat/chatFolderName'
import { folderTab, groupPageSlot, groupSlotMemory, isFolder, nextOpening, sameTab, type OpenedWith, type OpenRequest } from './groupSlotMemory'
import { AppPeekSlot } from './AppPeekSlot'
import { ClaimedPage } from './ClaimedPage'
import { peekStore } from '../../session/renderer/features/extensions/peek-store'
import { PhoneAppFrame } from './PhoneAppFrame'
import { updateUnasked } from './updateUnasked'
import { useSlotMakesWay } from './useSlotMakesWay'
import { rendererLogger } from '../../lib/log'
import { chatDb } from '../../lib/supabase'
import { cn } from '@/lib/cn'

const log = rendererLogger('app-slot/group')

/**
 * A file the person opened in a chat's panel (every way in ends here: the folder's list, a link, a card, 「用 X 打开」), kept
 * for them in the database (gugu-supabase 20261017002319) — so what they opened last is the same on every device, and an
 * App's `files.recent` reads it. An App reading a file again, or an agent working a page, is not the person opening it.
 */
function noteOpened(itemId: string): void {
  void chatDb.rpc('workspace_note_open', { p_item_id: itemId }).then(({ error }) => {
    if (error) log.warn({ itemId, error: error.message }, 'the open was not kept for 最近打开')
  })
}

export { WORKSPACE_APP_KIND } from './groupSlotMemory'

export interface GroupAppSlotProps {
  onForward?: (message: MessageItem) => void
  visible?: boolean
  chatId: string
  onClose: () => void
  /**
   * In a block, whose tab strip lists what the panel has open (gugu-dev#181 第 ⑥ 步): the tab is its title, its × and its
   * 展开 / 还原; the panel keeps only a slim row for what belongs to the page — 返回, the App's commands, its badge, its
   * error — and none when there is none of them.
   */
  tabbed?: boolean
  /** The panel takes the whole chat (desktop; the session page's right panel does the same): given, the header has the switch. */
  full?: boolean
  onToggleFull?: () => void
  /**
   * What this chat's panel was asked to open, every way in (`groupSlotMemory.ask`): an App — its own page, the file it
   * names in the chat (`chatFile`), or its files here (摩擦单 F51) — or a file of the group (F10), in the App that opens
   * it, at the place a pill points at.
   */
  asked?: OpenRequest | null
}

/** What 「返回」 reaches from a tab, nearest last: its 上一页, and that one's, while each is still open. */
function backChain(tabs: readonly OpenedWith[], item: OpenedWith): OpenedWith[] {
  const chain: OpenedWith[] = []
  for (let next = item.from; next; ) {
    const back = tabs.find((tab) => sameTab(tab, next!))
    if (!back || back === item || chain.includes(back)) break
    chain.unshift(back)
    next = back.from
  }
  return chain
}

/** Requests already answered: a panel shown again (remounted) does not open the same thing a second time. */
const answeredOpens = new Set<number>()

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

type Candidate = Extract<AppOpenWithDetail['choice'], { kind: 'one' }>['candidate']

/** An App as the panel names it to the person: in the interface language, as its manifest says it there. */
const appNameOf = (candidate: Pick<FileOpenerCandidate, 'app'>) => localizedManifestText(candidate.app, installedExtensionsStore.locale).name

/** The Apps on this device that may open something: main's list on the desktop, the phone's App store on the phone. */
const enabledApps = () => installedExtensionsStore.manifests.filter((manifest) => installedExtensionsStore.isEnabled(manifest.id))

/** How many toolbar entries fit beside the title in a slot at its narrowest (360); the rest fold into the menu. */
const INLINE_COMMANDS = 2

/**
 * The App kept to open this kind of file (「Always」, 摩擦单 F73), as this window knows it — kept by main on the desktop, by
 * the phone's App store on the phone (`appsHere.setOpenWithDefault`); the store holds this window's copy of either.
 */
function rememberedOpener(key: string): string | null {
  return installedExtensionsStore.openWithDefaults[key] ?? null
}

/**
 * A place in the group's side panel where an App draws (真源 §2.4: 群右栏槽位, 主人 09-29).
 *
 * - **Desktop**: the page lives in the session page's resident layer (extension-view-layer.tsx) — one
 *   page per App per group, which never changes group (摩擦单 F48). This element only claims it: the layer
 *   lays that group's page over this box.
 * - **Phone** (no Electron): the App runs right here, in an iframe of this page, which is its host
 *   (phoneAppHost.ts) — in an origin of its own (appOrigin.ts), from the phone's App store: shipped with
 *   this bundle, or installed from a card in a chat (phoneApps.ts, L9).
 *
 * Everything else — this group's shared packages and the 「用 X 打开 · 安装」 offer (F15), the update bar
 * (F66), a link or a card opening a file (F10 / F51), 「始终用它」 — is the same on both: it asks this
 * device's Apps (`appsHere`) and reads what is installed from `installedExtensionsStore`.
 *
 * 「用 X 打开」 (`gugu.files.openWith`) shows the chosen App here on that file, with a way back; when
 * several Apps claim the file the person picks, and may tick 「始终用它」. A file opened is always a
 * page of its own, made for that file and bound to it before it runs (摩擦单 F3): on the desktop the
 * claim carries the `itemId` and the layer makes that page; on the phone it is its own frame, over
 * the App's page, which stays as it was for the way back.
 */
export const GroupAppSlot = observer(function GroupAppSlot(props: GroupAppSlotProps) {
  const { t } = useTranslation('messaging')
  const opened = useSyncExternalStore(groupSlotMemory.subscribe, () => groupSlotMemory.opened(props.chatId))
  const tabs = useSyncExternalStore(groupSlotMemory.subscribe, () => groupSlotMemory.tabs(props.chatId))
  /** Its 上一页, while that is still open: what 「返回」 goes to. */
  const from = opened?.from ? tabs.find((item) => sameTab(item, opened.from!)) ?? null : null
  const folderName = useChatFolderName(props.chatId)
  const asking = useRef(0)
  const show = useCallback((next: OpenedWith) => {
    groupSlotMemory.open(props.chatId, next)
    if (next.itemId) noteOpened(next.itemId)
  }, [props.chatId])
  const [prompt, setPrompt] = useState<(AppOpenWithDetail & { restore?: () => void; from?: OpenedWith }) | null>(null)
  const [always, setAlways] = useState(false)
  /** The App's error spelled out under the header, when the person asked (摩擦单 F63). */
  const [errorShown, setErrorShown] = useState(false)
  // Only where the page is drawn differs (the resident layer and main's window events, or this page's iframe); what is
  // installed and what opens what is `appsHere` on both.
  const desktop = platform.kind === 'electron'
  const { user } = useAuth()
  const [offer, setOffer] = useState<Offer | null>(null)
  const [installingOffer, setInstallingOffer] = useState(false)
  /** The offered App did not install: said under the offer (why goes to the log), never a button that does nothing. */
  /** Why the offered App did not install, said under the offer: E-05's `refusedLine`, or that it failed. */
  const [offerFailed, setOfferFailed] = useState<string | null>(null)
  /** The market's Apps for this device, from its cached index (`unreadable`: the market could not be read). */
  const [market, setMarket] = useState<readonly MarketOffer[] | 'unreadable' | null>(null)
  /** Under an offer the file's raw content is folded away until asked for: the App to install first, not a screen of JSON. */
  const [rawShown, setRawShown] = useState(false)
  /** This chat's newest shared package of each App (摩擦单 F15): the one shared read (`sharedPackagesOf`). */
  const [shared, setShared] = useState<{ chatId: string; packages: ReadonlyMap<string, SharedPackage> } | null>(null)
  const [sharedCue, setSharedCue] = useState(0)

  useEffect(() => {
    if (!appsHere || !user?.id) return undefined
    let live = true
    const chatId = props.chatId
    sharedPackagesOf(chatId, user.id).then(
      (packages) => live && setShared({ chatId, packages }),
      () => live && setShared({ chatId, packages: new Map() }),
    )
    return () => {
      live = false
    }
  }, [props.chatId, user?.id, sharedCue])

  // The data file can be in the group before its App's card: the card goes out once the App passed its check (摩擦单 F15,
  // L5 S1 — ~2 s). When that card arrives the chat's list is read again, and a file already open gets its offer then.
  useEffect(
    () =>
      subscribeSharedPackages((chatId) => {
        if (chatId === props.chatId) setSharedCue((cue) => cue + 1)
      }),
    [props.chatId],
  )

  // Read the index in hand (161 10-15), never refresh it for a file: main's cache on the desktop, the phone's own.
  const typedName = opened?.kind ? opened.typedName : null
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
    if (!appsHere || !typedName || !shared || shared.chatId !== props.chatId) {
      setOffer(null)
      return undefined
    }
    return reaction(
      () => ({ installed: enabledApps(), all: installedExtensionsStore.manifests.slice() }),
      ({ installed, all }) => setOffer(offerFor(typedName, shared.packages, fromMarket, installed, all)),
      { fireImmediately: true },
    )
  }, [typedName, market, props.chatId, shared])
  useEffect(() => setRawShown(false), [opened?.itemId, props.chatId])
  /** A file opened before this chat's packages were read: held back for that moment, so an offer is not preceded by its raw JSON. */
  const offerUnknown = appsHere !== null && !!opened?.kind && !!opened.itemId && (!shared || shared.chatId !== props.chatId)
  /** The open file's raw page folds under an offer for it (not under one for a file nobody here opens). */
  const offerFolds = offer !== null && !rawShown

  // An App installed while a file of its kind is open here takes that file over, in place — from the offer
  // above or from a card in the chat alike (摩擦单 F15, L5 S1).
  useEffect(() => {
    const typedName = opened?.typedName
    if (!appsHere || !opened || !typedName) return undefined
    const asked = asking.current
    return reaction(enabledApps, (manifests) => {
      if (asked !== asking.current) return
      const choice = openerChoice(typedName, manifests, 'chat', rememberedOpener)
      if (choice.kind === 'one' && choice.candidate.tabKind !== opened.kind) {
        show({ kind: choice.candidate.tabKind, itemId: opened.itemId, typedName: opened.typedName, title: displayNameOf(opened.fileName ?? opened.title, choice.candidate.suffix), fileName: opened.fileName, opening: nextOpening(), restore: opened.restore, ...(opened.from ? { from: opened.from } : {}) })
      }
    })
  }, [opened, show])

  useEffect(() => setPrompt(null), [props.chatId])
  const fromMessage = !!opened?.restore
  // Back and × are one way out: to its 上一页 while that is open, else out of it (groupSlotMemory.close).
  const close = () => groupSlotMemory.close(props.chatId, opened, props.onClose)
  // On the phone the panel is a whole page (#6815): its way out is the top-left back — to the list from a file, else out
  // of the panel — and the back key does the same.
  const mobile = useMobileShell()
  useBackLayer(close, mobile)
  useSlotMakesWay(props, mobile)

  // The file asked last is the one opened: a pill clicked, then another (or a file in an App's list), before the first's
  // answer is back — whichever answer comes last, the panel ends on the later ask (#7257: it ended on the first when that
  // answer was slower). Each ask takes the next number; an answer to one that is not the latest is dropped.
  const openWith = useCallback(
    (detail: AppOpenWithDetail, message?: MessageItem, restore?: () => void, from?: OpenedWith) => {
      if (detail.chatId !== props.chatId) return
      const source = { ...(restore ? { restore } : {}), ...(from ? { from } : {}) }
      if (detail.choice.kind === 'none') {
        show({ kind: null, file: detail.file, message, itemId: detail.itemId, title: detail.name, typedName: detail.typedName, opening: nextOpening(), ...source })
        return
      }
      if (detail.choice.kind === 'one') {
        const { candidate } = detail.choice
        show({ kind: candidate.tabKind, itemId: detail.itemId, title: displayNameOf(detail.name, candidate.suffix), fileName: detail.name, typedName: detail.typedName, opening: nextOpening(), ...source })
        return
      }
      // 摩擦单 F73: a default already kept for this kind of file shows as a ticked 「Always」 (and a mark on its App).
      setAlways(detail.choice.kind === 'choose' && rememberedOpener(openWithKey('chat', detail.choice.suffix)) !== null)
      setPrompt({ ...detail, ...source })
    },
    [props.chatId, show],
  )
  /**
   * An App asked for a file (its list's click, `files.openWith`), resolved by its host: asked after any pill before it. A
   * file of another chat goes to the chat shell, which brings that chat up and hands it to its panel (MainLayout) — as
   * every `files.openWith` the desktop's main resolves does.
   */
  const openAsked = useCallback(
    (detail: AppOpenWithDetail, message?: MessageItem, restore?: () => void, from?: OpenedWith) => {
      if (detail.chatId !== props.chatId) {
        window.dispatchEvent(new CustomEvent<AppOpenWithDetail>(APP_OPEN_WITH_EVENT, { detail }))
        return
      }
      asking.current += 1
      openWith(detail, message, restore, from)
    },
    [openWith, props.chatId],
  )
  /** A page in this panel asked (a phone frame's `files.openWith`): what it opens has that page as its 上一页. */
  const askedByPage = useCallback(
    (detail: AppOpenWithDetail) => openAsked(detail, undefined, undefined, groupSlotMemory.opened(props.chatId) ?? undefined),
    [openAsked, props.chatId],
  )

  /** 摩擦单 F51: the files of the App whose card was opened, when there are several — listed above the workspace's list. */
  const [appFiles, setAppFiles] = useState<{ chatId: string; appName: string; files: { itemId: string; displayName: string }[] } | null>(null)
  useEffect(() => setAppFiles(null), [props.chatId])
  /** Why a file asked for could not be opened (gone, or not this group's): said here, not a click that does nothing. */
  const [unopened, setUnopened] = useState<string | null>(null)
  useEffect(() => setUnopened(null), [props.chatId])
  const openGroupFile = useCallback(
    async (itemId: string, at?: Record<string, string>, message?: MessageItem, restore?: () => void, from?: OpenedWith) => {
      if (!appsHere) return
      const asked = ++asking.current
      // `at`: the App that opens it gets the place as a `link` event, from the host that resolves who opens it.
      const result = await appsHere.groupFileOpener({ chatId: props.chatId, itemId, ...(at ? { at } : {}) })
      if (asked !== asking.current) return
      if (!result.success || !result.data) {
        // Never empty: an empty reason would read as "nothing to say" and the line would not show.
        setUnopened(result.error || 'no answer')
        return
      }
      setUnopened(null)
      setAppFiles(null)
      openWith(result.data, message, restore, from)
    },
    [openWith, props.chatId],
  )

  const installOffer = async () => {
    if (!offer || !appsHere) return
    setInstallingOffer(true)
    setOfferFailed(null)
    try {
      // The same install as the card's and the Apps page's: consent in place when it asks for anything (摩擦单 F6).
      const result =
        offer.from.kind === 'shared'
          ? await appsHere.installAttachment({ ...installPackageOf(offer.from.card), chatId: props.chatId })
          : await appsHere.installFromMarket({ ref: { extensionId: offer.from.extensionId, version: offer.from.version }, chatId: props.chatId })
      if (!result.success) {
        log.warn({ appName: offer.appName, from: offer.from.kind, error: result.error }, 'the App offered for a file did not install')
        setOfferFailed(t('chatArea.openWith.installFailed'))
        return
      }
      if (result.data && isInstallRefused(result.data)) {
        log.info({ appName: offer.appName, reason: result.data.reason }, 'the App offered for a file was refused')
        setOfferFailed(refusedLine(result.data))
        return
      }
      if (!result.data?.installed) return
      setOffer(null)
    } finally {
      setInstallingOffer(false)
    }
  }

  useEffect(() => {
    const ask = props.asked
    if (!appsHere || !ask || ask.chatId !== props.chatId || answeredOpens.has(ask.request)) return undefined
    answeredOpens.add(ask.request)
    if ('itemId' in ask) {
      // 「用 X 打开」 its host resolved already (who opens it, or among which to ask): opened as it said.
      if (ask.opener) openAsked(ask.opener, ask.message, ask.restore, ask.from)
      else void openGroupFile(ask.itemId, ask.at, ask.message, ask.restore, ask.from)
      return undefined
    }
    // 「在本群打开」(app-redesign §5), the folder too: what the App opens here is found first, so that one already open is
    // the tab shown (owner 10-24) — the file it names in this chat (`chatFile`, opened as that file is), its own page, or
    // where its files are (摩擦单 F51). Asked after any file before it: an answer to one of those later does not open over it.
    const asked = ++asking.current
    setPrompt(null)
    setUnopened(null)
    setAppFiles(null)
    if (ask.app === WORKSPACE_APP_ID) {
      show(folderTab())
      return undefined
    }
    const page = ask.tab ? installedExtensionsStore.allTabContributions.find((entry) => entry.kind === `${ask.app}.${ask.tab}`) : installedExtensionsStore.mainTabOf(ask.app)
    const namesFile = !ask.tab && installedExtensionsStore.isEnabled(ask.app) && installedExtensionsStore.manifestFor(ask.app)?.contributes.tabs.some((tab) => tab.chatFile)
    if (page?.enabled && !namesFile) {
      show({ kind: page.kind, title: page.title, opening: nextOpening() })
      return undefined
    }
    let live = true
    if (namesFile) {
      void appsHere.appChatFile({ chatId: ask.chatId, extensionId: ask.app }).then((result) => {
        if (!live || asked !== asking.current) return
        if (!result.success || !result.data) setUnopened(result.error || 'no answer')
        else openWith(result.data)
      })
    } else {
      void appsHere.groupFilesOpenedBy({ chatId: ask.chatId, extensionId: ask.app }).then((result) => {
        if (!live || asked !== asking.current || !result.success || !result.data) return
        const files = result.data
        if (files.length === 1) void openGroupFile(files[0]!.itemId)
        else if (files.length > 1) setAppFiles({ chatId: ask.chatId, appName: installedExtensionsStore.appName(ask.app) ?? ask.app, files })
      })
    }
    return () => {
      live = false
    }
    // `request`: each ask is answered anew, even for the same App.
  }, [openAsked, openGroupFile, openWith, props.asked, props.chatId, show])

  const pick = (detail: AppOpenWithDetail & { restore?: () => void; from?: OpenedWith }, candidate: Candidate) => {
    // Ticked: this App from now on. Unticked where a default was kept (the box came ticked): no default any more.
    const key = detail.choice.kind === 'choose' ? openWithKey('chat', detail.choice.suffix) : null
    const next = key === null ? undefined : always ? candidate.tabKind : rememberedOpener(key) !== null ? null : undefined
    if (key !== null && next !== undefined && appsHere) {
      // This window's copy too, as the session page's picker does: the next open here reads it (S18 on F73's first run).
      installedExtensionsStore.noteOpenWithDefault(key, next)
      void appsHere.setOpenWithDefault({ key, tabKind: next })
    }
    setPrompt(null)
    show({ kind: candidate.tabKind, itemId: detail.itemId, title: displayNameOf(detail.name, candidate.suffix), fileName: detail.name, typedName: detail.typedName, opening: nextOpening(), ...(detail.restore ? { restore: detail.restore } : {}), ...(detail.from ? { from: detail.from } : {}) })
  }

  const kind = opened?.kind ?? null

  // 摩擦单 F66 (S17): the App on screen is older here than a package of it shared in this group. From its publisher and
  // asking nothing new, it updates itself (`updateUnasked`) and the page reloads in place; otherwise — it asks for more,
  // or someone else sent it — a bar under the header says so, never in the way, and one click asks the person.
  // «This group's newest» is the one answer of F15 / F21 (`sharedPackagesOf`, `groupUpdateFor`).
  const shownApp = kind ? parseExtensionTabKind(kind)?.extensionId ?? null : null
  // #7050 左栏「退出」了这里开着的 App:它的这一格跟着收掉 —— 开着的文件回到列表,整格开着它的就关上。
  const closeQuit = useRef(() => {})
  closeQuit.current = close
  useEffect(() => {
    if (!shownApp) return undefined
    return reaction(
      () => installedExtensionsStore.quit.includes(shownApp),
      (quit) => { if (quit) closeQuit.current() },
    )
  }, [shownApp])
  const sharedHere = shownApp && shared && shared.chatId === props.chatId ? shared.packages.get(shownApp) : undefined
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
      const result = await appsHere.installAttachment({ ...installPackageOf(pkg.card), chatId: props.chatId })
      if (!result.success || !result.data) {
        log.warn({ package: packageKey(pkg.card), error: result.error }, "the group's App update did not install")
        setUpdateFailed(t('chatArea.openWith.installFailed'))
      } else if (isInstallRefused(result.data)) {
        log.info({ package: packageKey(pkg.card), reason: result.data.reason }, "the group's App update was refused")
        setUpdateFailed(refusedLine(result.data))
      }
    } finally {
      setUpdating(false)
    }
  }
  /** The phone's visible frame takes commands itself (set by it). */
  const frameCommand = useRef<((commandId: string) => void) | null>(null)
  const runCommand = (commandId: string) => {
    if (desktop) {
      const detail: AppSlotEventDetail = { type: 'command', slotId: groupPageSlot(props.chatId, opened), commandId }
      window.dispatchEvent(new CustomEvent(APP_SLOT_EVENT, { detail }))
    } else {
      frameCommand.current?.(commandId)
    }
  }
  const toolbar = kind ? declaredToolbarCommands(kind) : []
  const inline = toolbar.slice(0, INLINE_COMMANDS)
  const folded = [...toolbar.slice(INLINE_COMMANDS), ...(kind ? declaredMenuCommands(kind) : [])]
  const shown = extensionSurfaceStore.said(null, groupPageSlot(props.chatId, opened))
  // A session opened beside the page needs the room: the panel goes full while it is up, and back after (170 10-19 ③).
  const peekingSession = peekStore.of(null, groupPageSlot(props.chatId, opened))?.kind === 'session'
  const widenedFor = useRef(false)
  const toggleFull = useRef(props.onToggleFull)
  toggleFull.current = props.onToggleFull
  useEffect(() => {
    if (peekingSession && !props.full && toggleFull.current) {
      widenedFor.current = true
      toggleFull.current()
    } else if (!peekingSession && widenedFor.current) {
      widenedFor.current = false
      if (props.full) toggleFull.current?.()
    }
  }, [peekingSession, props.full])
  const heading = extensionTabTitle(shown, isFolder(opened) ? folderName : opened?.kind ? installedExtensionsStore.tabTitle(opened.kind) ?? opened.title : opened?.title ?? '', opened?.itemId ? { name: opened.title, path: opened.fileName ?? opened.title } : undefined)
  const badge = shown.badge
  const hasBadge = badge !== null && badge !== ''
  const appError = shown.error
  // Match the task split view's tab-strip actions without changing the existing button geometry.
  const headerButtonColors = mobile || !props.tabbed ? undefined : '!text-foreground-muted hover:!text-foreground hover:!bg-row-hover active:!bg-row-press'
  const backButton = from ? (
    <IconButton className={headerButtonColors} size={mobile ? 'lg' : 'sm'} data-testid="group-app-slot-back" onClick={close} aria-label={t('chatArea.openWith.back')}>
      <ChevronLeft />
    </IconButton>
  ) : null
  const closeButton = <IconButton className={headerButtonColors} size={mobile ? 'lg' : 'sm'} data-testid="group-app-slot-close" onClick={close} aria-label={t('common.close')}><X /></IconButton>
  const fullButton = mobile || !props.onToggleFull ? null : (
    <IconButton className={headerButtonColors} size="sm" data-testid="group-app-slot-full" aria-pressed={props.full === true} onClick={props.onToggleFull} aria-label={t(props.full ? 'chatArea.openWith.restore' : 'chatArea.openWith.maximize')} title={t(props.full ? 'chatArea.openWith.restore' : 'chatArea.openWith.maximize')}>
      {props.full ? <Minimize2 /> : <Maximize2 />}
    </IconButton>
  )
  const commands = (
    <>
      {inline.map((command) => (
        <Button className={headerButtonColors} key={command.id} size="sm" variant="ghost" data-command={command.id} onClick={() => runCommand(command.id)}>
          {command.title}
        </Button>
      ))}
      {folded.length > 0 ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className={cn('gg-ghost', headerButtonColors)} data-testid="group-app-slot-more" aria-label={t('chatArea.openWith.more')}>
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
  const slimRow = Boolean(backButton) || fromMessage || inline.length + folded.length > 0 || hasBadge || Boolean(appError) || fullButton !== null
  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="group-app-slot" data-app-kind={kind}>
      {opened?.file ? null : props.tabbed ? (slimRow ? (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-tab-strip px-2" data-testid="group-app-slot-bar">
          {backButton}
          {marks}
          <span className="ml-auto flex items-center gap-1">{commands}{fullButton}{fromMessage ? closeButton : null}</span>
        </div>
      ) : null) : <PaneHeader
        title={<span title={heading.tooltip}>{heading.label}</span>}
        divider
        // 手机上是一整页:页头和别的手机页同一档(peek 盖上来时也是这一档,一个页头)。
        {...(mobile ? { mobile: true } : {})}
        leading={backButton ?? (mobile && !fromMessage ? <RightPanelBackButton onBack={close} /> : undefined)}
        actions={
          <>
            {commands}
            {fullButton}
            {mobile && !fromMessage ? null : closeButton}
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
          {updateFailed}
        </div>
      ) : null}
      {unopened ? (
        <div className="border-b border-[var(--border)] !px-3 !py-2 text-[length:var(--font-caption)] text-[var(--text-error)]" data-testid="group-app-slot-unopened">
          {/* Why is in main's log; the person reads what can be the case here. */}
          {t('chatArea.openWith.fileUnavailable')}
        </div>
      ) : null}
      {appFiles && appFiles.chatId === props.chatId ? (
        <div className="flex flex-col items-stretch gap-1 border-b border-[var(--border)] !p-3" data-testid="group-app-slot-app-files">
          <div className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t('chatArea.openWith.appFiles', { name: appFiles.appName })}</div>
          {appFiles.files.map((file) => (
            <Button key={file.itemId} size="sm" variant="ghost" className="justify-start" data-app-file={file.itemId} onClick={() => void openGroupFile(file.itemId)}>
              {file.displayName}
            </Button>
          ))}
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
              {offerFailed}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" data-testid="group-app-slot-offer-install" disabled={installingOffer} onClick={() => void installOffer()}>
              {t('chatArea.openWith.install')}
            </Button>
            <Button size="sm" variant="ghost" data-testid="group-app-slot-offer-raw" onClick={() => setRawShown((shown) => !shown)}>
              {rawShown ? t('chatArea.openWith.hideRaw') : t('chatArea.openWith.showRaw')}
            </Button>
          </div>
        </div>
      ) : null}
      {/* What the page on screen opens beside it (G1): over it here, the page kept for the way back. */}
      <AppPeekSlot sessionId={null} tabId={groupPageSlot(props.chatId, opened)} narrow={mobile}>
        {opened?.file && (!mobile || props.visible !== false) ? <MessageFilePreview key={opened.opening} fill tabbed={props.tabbed} mobile={mobile} message={opened.message} onForward={props.onForward} file={{ kind: 'file', document: opened.file.document, fileName: opened.fileName ?? opened.title, mimeType: opened.file.contentType, sizeBytes: opened.file.size, source: { kind: 'item', itemId: opened.itemId!, version: opened.file.version } }} onBack={from ? close : undefined} full={props.full} onToggleFull={props.onToggleFull} onClose={close} /> : null}
        {desktop ? opened?.file || !kind ? null : (
          offerUnknown || offerFolds ? (
            <div className="min-h-0 flex-1" data-testid="group-app-slot-raw-folded" />
          ) : (
            <ClaimedPage slotId={groupPageSlot(props.chatId, opened)} chatId={props.chatId} kind={kind} itemId={opened?.itemId} opening={opened?.opening} />
          )
        ) : (
          <>
            {/* Under an offer the file's raw page waits, as on the desktop: the App to install first (摩擦单 F15). */}
            {opened && (offerUnknown || offerFolds) ? <div className="min-h-0 flex-1" data-testid="group-app-slot-raw-folded" /> : null}
            {/* What 「返回」 reaches stays as it was, hidden (G2) — a frame, unlike a desktop page, is not kept elsewhere. */}
            {(opened ? [...backChain(tabs, opened), ...(offerUnknown || offerFolds ? [] : [opened])] : []).filter((entry) => entry.kind !== null).map((entry) => (
              <PhoneAppFrame
                key={`${entry.kind}:${entry.itemId}:${entry.opening}`}
                chatId={props.chatId}
                kind={entry.kind!}
                itemId={entry.itemId}
                hidden={entry !== opened}
                onOpenWith={askedByPage}
                tabId={groupPageSlot(props.chatId, entry)}
                commandRef={entry === opened ? frameCommand : undefined}
                testId="group-app-frame"
                missingTestId="group-app-slot-missing"
              />
            ))}
          </>
        )}
      </AppPeekSlot>
      {prompt && prompt.choice.kind === 'choose' ? (
        <div className="absolute inset-x-0 bottom-0 top-0 z-10 flex flex-col gap-3 bg-[var(--bg-primary)] !p-4" data-testid="group-app-open-with">
          {/* The name as the file list says it (摩擦单 F73 / F39), not the raw one with the suffix it is claimed by. */}
          <div className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">
            {t('chatArea.openWith.title', { name: displayNameOf(prompt.name, prompt.choice.suffix) })}
          </div>
          {prompt.choice.candidates.map((candidate) => (
            <Button key={candidate.tabKind} variant="secondary" data-open-with={candidate.tabKind} onClick={() => pick(prompt, candidate)}>
              <span className="flex flex-col items-start">
                <span className="flex items-center gap-2">
                  {appNameOf(candidate)}
                  {prompt.choice.kind === 'choose' && rememberedOpener(openWithKey('chat', prompt.choice.suffix)) === candidate.tabKind ? (
                    <Chip data-testid="group-app-open-with-default">{t('chatArea.openWith.default')}</Chip>
                  ) : null}
                </span>
                {candidate.onlyTab ? null : <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{candidate.tabTitle}</span>}
              </span>
            </Button>
          ))}
          <label className="flex items-center gap-2 text-[length:var(--font-body)] text-[var(--text-secondary)]">
            <input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} data-testid="group-app-open-with-always" />
            {t('chatArea.openWith.always')}
          </label>
          <Button variant="ghost" onClick={() => setPrompt(null)}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : null}
    </div>
  )
})
