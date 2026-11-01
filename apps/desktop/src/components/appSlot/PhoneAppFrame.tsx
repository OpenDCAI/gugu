import { followLink, openLinkTarget } from '../../lib/guguLinks'
import { reaction } from 'mobx'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { readMemberRosterRevision, readWorkspaceChanges } from '../../lib/accountRevisionCoordinator'
import { extensionSurfaceStore } from '../../session/renderer/features/extensions/extension-surface-store'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import {
  APP_SESSION_FRAME_NAME,
  type AppOpenWithDetail,
  type AppShowMessageDetail,
} from '../../session/shared/extensions/app-runtime-protocol'
import type { ExtensionCapability } from '../../session/shared/extensions/manifest'
import { extensionProgramNotifiedChannel } from '../../session/shared/extensions/marketEvents'
import { listedSession, liveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { useChatStore } from '../../store/chatContext'
import { useDevicesStore } from '../../store/devicesContext'
import { useTheme } from '../../store/theme'
import { hostAppFrame, type PhoneAppBinding } from './phoneAppHost'
import { phoneApps } from './phoneApps'
import type { SessionpageOpenedFileChunk, SessionpageOpenedFileReadRequest } from '@gugu/session-core/session-record/contract'
import { composeChatDraft } from '../../lib/composeDraft'
import { peekStore } from '../../session/renderer/features/extensions/peek-store'

const OpenedFilePreview = lazy(() => import('../../mobile/agent-watch/opened-output-opener').then((m) => ({ default: m.OpenedFilePreview })))

/** The App a frame draws: its page, what it may do, and the version — a new one reloads the frame in place (摩擦单 F66). */
interface FramedPage {
  src: string
  version: string
  capabilities: readonly ExtensionCapability[]
}

/**
 * One App frame on the phone, wherever it is drawn — a chat's tab (GroupTabContent), a session's tab, an App's own page
 * (SessionAppFrame): one host, one set of what it hears, so a page answers the same in each.
 *
 * The App is what the phone's App store has installed now (`installedExtensionsStore`): updated, the frame reloads on the
 * new version; uninstalled, it goes — its host with it, and the grants it held with the file service. Its page comes
 * from the App's own origin (`phoneApps.pageUrl`, appOrigin.ts), never the gugu page's own: that is why
 * `allow-same-origin` is safe here — the App gets its own storage, and still cannot reach this page.
 */
export function PhoneAppFrame({
  kind,
  tabId,
  chatId,
  itemId,
  session,
  hidden = false,
  onOpenWith,
  commandRef,
  testId,
  missingTestId,
}: {
  kind: string
  /** The slot it is drawn in: what the page says about itself is kept by it. */
  tabId: string
  chatId: string | null
  /** Made for that file: keeps it for life (the slot keys the frame so). */
  itemId?: string
  /** owner 10-16 The session it is drawn in, on one of the person's computers: its context, and where its program runs. */
  session?: NonNullable<PhoneAppBinding['session']>
  /** Under a file opened over it: kept running, as it was, for the way back. */
  hidden?: boolean
  onOpenWith: (detail: AppOpenWithDetail) => void
  /** Set while this frame is the one on screen: the slot's toolbar / menu reach it through this. */
  commandRef?: { current: ((commandId: string) => void) | null }
  testId: string
  missingTestId: string
}) {
  const extensionId = kind.split('.')[0] ?? kind
  const tabName = kind.slice(extensionId.length + 1)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const hostRef = useRef<ReturnType<typeof hostAppFrame> | null>(null)
  const [workingCopy, setWorkingCopy] = useState<{ path: string; readFileChunk: (input: SessionpageOpenedFileReadRequest) => Promise<SessionpageOpenedFileChunk> } | null>(null)
  const onOpenWithRef = useRef(onOpenWith)
  onOpenWithRef.current = onOpenWith
  // The person's computers, as the task tab lists them: `showSession` opens a row of that list.
  const { devices } = useDevicesStore()
  const devicesRef = useRef(devices)
  devicesRef.current = devices
  const [app, setApp] = useState<FramedPage | null>(null)
  const [missing, setMissing] = useState(false)
  const { theme } = useTheme()
  const { i18n } = useTranslation()
  const { t } = useTranslation('messaging')
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')

  // The App as installed here now, and where its page is (a new version is another page).
  useEffect(() => {
    return reaction(
      () => {
        const manifest = installedExtensionsStore.isLoaded && installedExtensionsStore.isEnabled(extensionId) ? installedExtensionsStore.manifestFor(extensionId) : undefined
        return { loaded: installedExtensionsStore.isLoaded, manifest }
      },
      ({ loaded, manifest }) => {
        if (!manifest) {
          setApp(null)
          setMissing(loaded)
          return
        }
        const tab = manifest.contributes.tabs.find((candidate) => candidate.name === tabName)
        // A tab with no page of its own (or one gugu draws itself) has nothing to put here.
        const entry = tab?.entry ?? manifest.entry
        if (!entry || tab?.hostPage) {
          setApp(null)
          setMissing(true)
          return
        }
        setMissing(false)
        setApp({ src: phoneApps.pageUrl(extensionId, entry), version: manifest.version, capabilities: manifest.permissions?.capabilities ?? [] })
      },
      { fireImmediately: true, equals: (a, b) => a.loaded === b.loaded && a.manifest === b.manifest },
    )
  }, [extensionId, tabName])

  // What the host is told about where it is; read when the host starts and on every change.
  const bindingRef = useRef<Omit<PhoneAppBinding, 'capabilities'>>({ extensionId, tabId, tabName, chatId, locale: i18n.language, themeMode: 'light' })
  bindingRef.current = {
    extensionId,
    tabId,
    tabName,
    chatId,
    ...(session ? { session } : {}),
    ...(itemId ? { itemId } : {}),
    locale: i18n.language,
    themeMode: theme === 'dark' ? 'dark' : 'light',
  }
  const deviceId = session?.deviceId

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !app) return undefined
    const host = hostAppFrame(frame, { ...bindingRef.current, capabilities: app.capabilities }, {
      showMessage: async (detail: AppShowMessageDetail) => { await openLinkTarget({ kind: 'chat', chatId: detail.chatId, messageId: detail.messageId }) },
      showSession: (sessionId, peek) => {
        const listed = listedSession(devicesRef.current, liveDeviceSessions(), sessionId)
        if (!('row' in listed)) return listed
        // Beside the page (G1): its timeline over this frame; else the task tab opens its row.
        if (peek) peekStore.open(null, bindingRef.current.tabId, { kind: 'session', sessionId, projectId: listed.row.session.projectId, deviceId: listed.row.deviceId })
        else followLink({ kind: 'session', sessionId, deviceId: listed.row.deviceId })
        return { shown: true }
      },
      openWith: (detail) => onOpenWithRef.current(detail),
      openWorkingCopy: (path, read) => setWorkingCopy({ path, readFileChunk: ({ offset, length }) => read(offset, length) }),
      // The slot this frame is in draws it (AppPeekSlot), as main's peek on the desktop.
      peek: (target) => peekStore.open(null, bindingRef.current.tabId, target),
      // The phone's host is this page: what the App says about itself goes where main's relay puts it on the desktop.
      chrome: (next) => extensionSurfaceStore.say(null, bindingRef.current.tabId, next),
    })
    hostRef.current = host
    // In a session, what the program on that computer sends comes through its window; only this App's. Imported only
    // then: the session page's connections are not a chat's panel's to load.
    let off: () => void = () => undefined
    let gone = false
    if (deviceId) {
      void import('../../mobile/agent-watch/sessionpage-rpc').then(({ onMachineChannel }) => {
        if (gone) return
        off = onMachineChannel(deviceId, extensionProgramNotifiedChannel.name, (data) => {
          const notification = data as { extensionId?: string; server?: string; method?: string; params?: unknown } | null
          if (notification?.extensionId !== extensionId || typeof notification.server !== 'string' || typeof notification.method !== 'string') return
          host.programNotified({ server: notification.server, method: notification.method, ...(notification.params === undefined ? {} : { params: notification.params }) })
        })
      })
    }
    return () => {
      gone = true
      off()
      hostRef.current = null
      host.dispose()
    }
  }, [app, deviceId, extensionId])

  // The frame on screen takes the slot header's toolbar / menu commands.
  useEffect(() => {
    if (!commandRef || !app) return undefined
    const take = (commandId: string) => hostRef.current?.command(commandId)
    commandRef.current = take
    return () => {
      if (commandRef.current === take) commandRef.current = null
    }
  }, [app, commandRef])

  useEffect(() => {
    if (app) hostRef.current?.update({ ...bindingRef.current, capabilities: app.capabilities })
  }, [app, chatId, itemId, theme, i18n.language, session?.online])

  // Chats' files changed (the account revision bus names them, #7257): the App hears about the ones it asked about
  // (files.onChanged) — the host reads them; not awaited here, as on the desktop (useExtensionWorkspaceRevisions).
  useEffect(
    () =>
      subscribeAccountRevision('workspace_changed', (operations) => {
        const changes = readWorkspaceChanges(operations.map((operation) => operation.payload))
        if (changes.length > 0) void hostRef.current?.filesChanged(changes)
      }),
    [subscribeAccountRevision],
  )
  // A row of its chat's members changed: the App's context says who is in the chat (摩擦单 F36) — told when that moved
  // who is there (`rosterMoved`, in the host). A frame in no chat has no members to hear about.
  useEffect(() => {
    if (!chatId) return undefined
    return subscribeAccountRevision('chat_members_changed', (operations) => {
      const changes = operations.map((operation) => readMemberRosterRevision(operation.payload)).filter((change) => change.chatId === chatId)
      if (changes.length > 0) hostRef.current?.membersChanged(changes)
    })
  }, [chatId, subscribeAccountRevision])

  // Uninstalled, or switched off (161 10-16: the phone has switches now) while its page was what was drawn here: said in
  // the sentence the desktop says it — not a blank page.
  if (missing) {
    return (
      <div hidden={hidden} className="min-h-0 flex-1" data-testid={missingTestId}>
        <p className="!p-4 text-[length:var(--font-body)] text-[var(--text-secondary)]">{t('chatArea.openWith.unavailable')}</p>
      </div>
    )
  }
  if (!app) return <div hidden={hidden} className="min-h-0 flex-1" />
  return (
    <>
      {workingCopy ? <Suspense fallback={null}><OpenedFilePreview
        {...workingCopy} deviceId={session?.deviceId ?? ''} sessionId={session?.id ?? ''}
        onQuote={(text) => { if (chatId) composeChatDraft({ chatId, text }) }}
      /></Suspense> : null}
      <iframe
        // Another version or another account is another document: a new frame, and a new host for it.
        key={`${app.version}:${app.src}`}
        ref={frameRef}
        hidden={hidden}
        title={extensionId}
        // Tells the page's runtime it is in a session: its program calls go to that computer (framed-host.ts).
        {...(session ? { name: APP_SESSION_FRAME_NAME } : {})}
        // Its own origin (appOrigin.ts), never this page's: storage of its own, and still no way to this page or its
        // credentials — it reaches gugu through its host alone. No popups or top navigation. Forms submit as on the desktop: the
        // page's own submit handler runs, and a form that would go somewhere is stopped by the App's CSP (`form-action 'none'`).
        sandbox="allow-scripts allow-same-origin allow-forms"
        src={app.src}
        className="min-h-0 w-full flex-1 border-0"
        data-testid={testId}
        data-app-item={itemId}
        data-app-version={app.version}
      />
    </>
  )
}
