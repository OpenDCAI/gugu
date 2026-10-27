import { fileBlob } from '@gugu/core/shared/fileResolver'
import { guguLink, guguLinkScheme, linkTargetOf, type GuguLinkTarget } from '@gugu/core/shared/ui/guguLink'
import { openLinkWith } from '../../session/shared/extensions/open-link'
import { openLinkTarget } from '../../lib/guguLinks'
import { resourceChatIdOf } from '../../session/shared/extensions/app-files-core'
import { readCachedDevices } from '../../store/devicesCache'
import { listedSession, liveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { rendererLogger } from '../../lib/log'
import { platform } from '../../platform'
import { getRendererAccessToken } from '../../lib/sessionPublication'
import { AppFileError, contentTypeOf, createAppFiles, rosterMoved, tooLargeError, type ChatFileRef, type FileSurface, type MemberChange } from '../../session/shared/extensions/app-files-core'
import { AppSendError, dispatchFromApp, type AppSendPlatform } from '../../session/shared/extensions/app-send-core'
import { pickDispatchTarget } from '../chat/dispatchAsk'
import { chatOf, createAppMessages } from '../../session/shared/extensions/app-messages-core'
import { createAppForum, type ForumChannel } from '../../session/shared/extensions/app-forum-core'
import { dataClient } from '../../lib/supabase'
import { subscribeAuthenticatedRealtimeChannel, unsubscribeAuthenticatedRealtimeChannel } from '../../lib/realtimeChannel'
import { FileSyncRelay, webSocketUrl, type PageSync } from '../../session/shared/extensions/file-sync-core'
import { userIdFromSupabaseAccessToken } from '@gugu/core/cloud/runtimeAuthProvider'
import {
  APP_COMPOSE_EVENT,
  APP_FORUM_CONSENT_EVENT,
  APP_FILE_MAX_BYTES,
  APP_FRAME_MARKER,
  SYNC_PORT_WINDOW_MESSAGE,
  fileRefOf,
  fileSearchOf,
  isLocal,
  placeOf,
  sessionIdOf,
  type AppComposeDetail,
  type AppForumConsentDetail,
  type AppFileUpload,
  type AppOpenWithDetail,
  type AppShowMessageDetail,
  type FrameToHost,
  type HostToFrame,
  type PeekTarget,
} from '../../session/shared/extensions/app-runtime-protocol'
import {
  bridgeFailure,
  callRefusal,
  EXTENSION_API_VERSION,
  pageArgument,
  verbFacts,
  type ExtensionChat,
  type ExtensionHostContext,
  type ExtensionHostEvent,
  type ExtensionMember,
} from '../../session/shared/extensions/bridge-protocol'
import { filesOpenedBy } from '../../session/shared/extensions/app-files-core'
import { coalescedReads } from '../../session/shared/extensions/coalesced-reads'
import { localizedManifestText } from '../../session/shared/extensions/catalog'
import { claimantOf, openerChoice, placeFor, placeLink, type FileOpenerCandidate } from '../../session/shared/extensions/file-openers'
import { opensInChats, withCoveredCapabilities, type ExtensionCapability, type ExtensionManifest } from '../../session/shared/extensions/manifest'
import { readDisplayIdentities } from '../../lib/identityReadAdapter'
import { memberFaces } from '../../lib/memberFaces'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { fileIconKey } from '../../session/shared/extensions/app-icon'
import { appFrameChannel } from './appOrigin'
import { PHONE_CAPABILITIES, phoneApps } from './phoneApps'
import { cachedPhoneAgents, phoneDispatch } from './phoneDispatch'
import { onPhoneAppState, phoneAppState } from './phoneAppState'
import { subscribeDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { callOnComputer } from './phoneProgramCall'
import { appDeviceId, followsSessionMachine, notOnSessionMachine } from '../../session/shared/extensions/machine-call'
import { HOSTED_PROGRAM_ELSEWHERE } from '../../session/shared/extensions/program-place'
import { rendererFileServiceUrl } from '../../lib/chatFolder'
import { AppModalSessions, type AppModalFocus } from '../../session/shared/extensions/app-modal'
import { closeAppModal, focusAppModalClose, showAppModal } from '../appModal/appModal'
import { APP_SESSION_FRAME_NAME } from '../../session/shared/extensions/app-runtime-protocol'

const log = rendererLogger('app-slot/phone-host')

/**
 * The host of an App on the phone (真源 §2.2): the outer gugu page, around the App's sandboxed
 * iframe. What main does on the desktop happens here — the credential, the one connection to the
 * file service, what the page may enter, the files it may touch — with the very same code
 * (`file-sync-core`, `app-files-core`). The iframe gets bytes and answers, never the token.
 *
 * Only what the phone has is answered: the rest is `invalid` (an App feature-detects, and the
 * runtime in the frame only offers what `framed-host.ts` lists).
 */

/**
 * This phone can use the App (app-redesign §5): it has something to open here — a page of its own, which opens in any
 * group, or a tab for group files. Never hidden for what it asks (真源 §2.6): what the phone cannot do is not on the
 * page's `gugu`, and its context's `capabilities` hold only what the phone has.
 */
export function phoneRuns(manifest: ExtensionManifest): boolean {
  return opensInChats(manifest)
}

export interface PhoneAppBinding {
  modal?: { id: string; data?: unknown }
  extensionId: string
  /** The slot drawing it. */
  tabId: string
  tabName: string
  /** The chat it is drawn for — null for a page in a session (`session`). */
  chatId: string | null
  /**
   * owner 10-16 The session it is drawn in, on one of the person's computers (the phone has none of its own): what its
   * context says, and where its `callProgram` runs.
   */
  session?: { id: string; deviceId: string; deviceLabel: string | null; projectId?: string; online?: boolean }
  itemId?: string
  /** What the App's manifest declares (preinstalled: reviewed with gugu, no consent asked). */
  capabilities: readonly ExtensionCapability[]
  locale: string
  themeMode: 'light' | 'dark'
}

interface HostedFrame {
  frame: HTMLIFrameElement
  binding: PhoneAppBinding
  /** Its open files with the relay, once it opened a file: the port went to its document. */
  syncPage(): PageSync
  deliver(event: ExtensionHostEvent): void
}

const frames = new Map<number, HostedFrame>()
const phoneModals = new AppModalSessions<PhoneAppBinding>((modal) => { closeAppModal(modal.id) })
let nextPageId = 1

/** A frame's binding as kept here: its granted words with the narrower ones they cover, so a check for those finds them. */
const granted = (binding: PhoneAppBinding): PhoneAppBinding => ({ ...binding, capabilities: withCoveredCapabilities(binding.capabilities) })

const relay = new FileSyncRelay({
  serviceUrl: () => webSocketUrl(rendererFileServiceUrl()),
  connect(url, protocols, events) {
    const ws = new WebSocket(url, protocols)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => events.open()
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) events.message(new Uint8Array(event.data))
    }
    ws.onclose = (event) => events.close(event.code, event.reason)
    ws.onerror = () => events.error('connection error')
    return {
      send: (frame) => ws.send(frame as Uint8Array<ArrayBuffer>),
      close: (code, reason) => ws.close(code, reason),
      // A browser WebSocket has no ping of its own; the service pings (Hocuspocus Ping) and the
      // relay answers. A dead network closes the socket, and the providers retry.
      ping: () => false,
      terminate: () => ws.close(),
    }
  },
  token: async () => getRendererAccessToken(),
  hasCapability: (extensionId, capability) =>
    [...frames.values()].some((hosted) => hosted.binding.extensionId === extensionId && hosted.binding.capabilities.includes(capability)),
  warn: (message, data) => log.warn(data ?? {}, message),
})

/** The Apps on this phone — shipped and installed from chats (phoneApps.ts fills the store) — that may be opened. */
function appsHereNow(): ExtensionManifest[] {
  return installedExtensionsStore.manifests.filter((manifest) => installedExtensionsStore.isEnabled(manifest.id))
}

/** `gugu.dispatch` (15): the desktop's answer (`app-send-core.ts`), as the person signed in to this page. */
const sendPlatform: AppSendPlatform = {
  async account() {
    const token = getRendererAccessToken()
    const userId = token ? userIdFromSupabaseAccessToken(token) : null
    if (!token || !userId) throw new AppSendError('failed', 'Not signed in')
    return { token, userId }
  },
}
/** `gugu.messages`: the desktop's answer (`app-messages-core.ts`), as the person signed in to this page. */
const messagesForApp = createAppMessages(sendPlatform)
/** A forum channel on this page's realtime client (signed in as the person; re-subscribed when it drops). */
const forumChannel: ForumChannel = (topic, event, onPayload, onSubscribed) => {
  const channel = subscribeAuthenticatedRealtimeChannel(
    () => dataClient
      .channel(topic, { config: { private: true, broadcast: { self: false, ack: true } } })
      .on('broadcast', { event }, (message) => onPayload((message.payload ?? {}) as Record<string, unknown>)),
    `forum:${topic}`,
    { onSubscribed, reconnectWhenIdle: false },
  )
  return () => {
    void unsubscribeAuthenticatedRealtimeChannel(channel)
  }
}
/** `gugu.forum`: the desktop's answer (`app-forum-core.ts`), as the person signed in to this page. */
const forumForApp = createAppForum({ account: () => sendPlatform.account(), channel: forumChannel })
/** The forum consent sheet (ForumConsent: points, assigning), drawn by this page's shell as the desktop window draws it. */
const askForumConsent = (detail: AppForumConsentDetail) => {
  window.dispatchEvent(new CustomEvent<AppForumConsentDetail>(APP_FORUM_CONSENT_EVENT, { detail }))
  return { confirming: true }
}

const files = createAppFiles({
  async resolveFile(ref, actorId, options) {
    if (options.localOnly) return null;
    if (!('id' in ref)) throw new AppFileError('invalid', 'A stored file must be resolved by its id');
    const { resolveFile, fileReader, fileReadSignal } = await import('../../lib/fileAccess');
    return resolveFile({ item_id: ref.id, ...(options.version ? { version: options.version } : {}) }, fileReader(actorId), { signal: fileReadSignal() });
  },
  // Who opens a group file of this kind here — the same choice a tap makes (摩擦单 F39).
  claimant(typedName) {
    const candidate = claimantOf(typedName, appsHereNow(), 'chat', phoneApps.remembered)
    if (!candidate) return null
    // The icon it declared for this kind of file (`fileIcons`), as this page re-encoded it (app-icon.ts) — as main does on the desktop.
    const icon = installedExtensionsStore.icons[fileIconKey(candidate.tabKind, candidate.suffix)] ?? null
    return { suffix: candidate.suffix, app: { id: candidate.extensionId, name: localizedManifestText(candidate.app, installedExtensionsStore.locale).name, icon } }
  },
  async account() {
    const token = getRendererAccessToken()
    const userId = token ? userIdFromSupabaseAccessToken(token) : null
    if (!token || !userId) throw new AppFileError('failed', 'Not signed in')
    return { token, userId }
  },
  hasCapability: (extensionId, capability) =>
    [...frames.values()].some((hosted) => hosted.binding.extensionId === extensionId && hosted.binding.capabilities.includes(capability)),
  // Who people are, read the way the rest of this page reads them (the IM's one identity reader).
  identities: async (_token, ids) =>
    (await readDisplayIdentities(ids)).map((identity) => ({ id: identity.id, name: identity.display_name, avatar: identity.avatar, kind: identity.type })),
  // Drawn here, as this page draws every face.
  faces: memberFaces,
  filesUrl: rendererFileServiceUrl,
  warn: (message, data) => log.warn(data ?? {}, message),
  sync: {
    ensureFor: (asAgent) => { relay.ensureFor(asAgent) },
    pageFor: (pageId) => {
      const hosted = frames.get(pageId)
      if (!hosted) throw new AppFileError('failed', 'This surface is gone')
      return hosted.syncPage()
    },
    grant: (page, grant) => relay.grant(page, grant),
    ungrant: (pageId, docName) => relay.ungrant(pageId, docName),
    revoke: (pageId, reason, docNames) => relay.revoke(pageId, reason, docNames),
  },
})

/** The phone's own picker, inside the person's gesture. Cancelled is an empty list. */
function pickFiles(): Promise<AppFileUpload[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.addEventListener('cancel', () => resolve([]), { once: true })
    input.addEventListener(
      'change',
      () => {
        const picked = [...(input.files ?? [])]
        const tooLarge = picked.filter((file) => file.size > APP_FILE_MAX_BYTES).map((file) => file.name)
        if (tooLarge.length > 0) return reject(tooLargeError(tooLarge))
        Promise.all(
          picked.map(async (file) => ({ name: file.name, contentType: file.type || contentTypeOf(file.name), bytes: await file.arrayBuffer() })),
        ).then(resolve, reject)
      },
      { once: true },
    )
    input.click()
  })
}

function refused(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

type Result<T> = { success: true; data: T } | { success: false; error: string }
const failure = (error: unknown): { success: false; error: string } => ({ success: false, error: error instanceof Error ? error.message : String(error) })

/**
 * App 引用 pill: places pills point at, each for the page about to open its file in that chat (`groupFileOpener`), handed
 * over when a page of that file first asks for its context — the runtime is up then; the frame holds it until `onLink`
 * (framed-host) — or when a page is moved to that file (`update`). In the order they came: the page keeps the last.
 * Never to a page of another file of the chat (复核 71c15165 要改 1). Bounded in time, as the desktop's.
 */
const OPENING_LINK_TTL_MS = 30_000
const openingLinks: { extensionId: string; chatId: string | null; itemId: string | null; sessionId?: string; event: ExtensionHostEvent; expiresAt: number }[] = []
export function holdPlaceForOpeningPage(chatId: string, itemId: string, candidate: FileOpenerCandidate, at: Record<string, string>): void {
  openingLinks.push({ extensionId: candidate.extensionId, chatId, itemId, event: placeLink(candidate, at, itemId), expiresAt: Date.now() + OPENING_LINK_TTL_MS })
}
function takeOpeningLinks(binding: PhoneAppBinding): ExtensionHostEvent[] {
  const now = Date.now()
  const taken: ExtensionHostEvent[] = []
  for (let i = 0; i < openingLinks.length; ) {
    const opening = openingLinks[i]!
    const mine = opening.extensionId === binding.extensionId && opening.chatId === binding.chatId && (opening.sessionId ?? null) === (binding.session?.id ?? null)
      && (opening.event.type !== 'link' || opening.event.tab === binding.tabName)
      && (opening.itemId === null ? !binding.itemId : opening.itemId === binding.itemId)
    if (opening.expiresAt < now || mine) {
      openingLinks.splice(i, 1)
      if (opening.expiresAt >= now) taken.push(opening.event)
    } else {
      i += 1
    }
  }
  return taken
}

/**
 * A file of this group opened from the shell — a link (摩擦单 F10), an App card's 「Open」 (F51): which App opens it, as
 * a tap in an App decides it (`openerChoice`; `none`: the panel offers an App that would) — main's `groupFileOpener` on
 * the desktop, this page's on the phone.
 */
export async function groupFileOpener(args: { chatId: string; itemId: string; at?: Record<string, string> }): Promise<Result<AppOpenWithDetail>> {
  try {
    const target = await files.groupFile(args.chatId, args.itemId)
    const choice = openerChoice(target.typedName, appsHereNow(), 'chat', phoneApps.remembered)
    // App 引用 pill: the place, for the page about to open the file — main's `deliverToOpeningPage` on the desktop.
    const place = placeFor(choice, args.at)
    if (place) holdPlaceForOpeningPage(target.chatId, target.itemId, place.candidate, place.at)
    return { success: true, data: { ...target, choice } }
  } catch (error) {
    return failure(error)
  }
}

/** API 14 `chatFile`: the file an App opened in this chat shows, as that file opened with it (made the first time) — main's answer too. */
export async function appChatFile(args: { chatId: string; extensionId: string }): Promise<Result<AppOpenWithDetail>> {
  try {
    return { success: true, data: await files.appChatFile(args.chatId, appsHereNow().find((manifest) => manifest.id === args.extensionId)) }
  } catch (error) {
    return failure(error)
  }
}

/** 摩擦单 F51: the files of this group a tap opens with this App, newest first (`filesOpenedBy`, main's answer too). */
export async function groupFilesOpenedBy(args: { chatId: string; extensionId: string }): Promise<Result<ReturnType<typeof filesOpenedBy>>> {
  try {
    return { success: true, data: filesOpenedBy(await files.groupFiles(args.chatId), args.extensionId) }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Put `frame` (an App's sandboxed iframe) under this page's hosting. Returns what the slot drives:
 * a new binding (another group, another file), a workspace change to pass on, and the end.
 */
export function hostAppFrame(
  frame: HTMLIFrameElement,
  initial: PhoneAppBinding,
  hooks: {
    showMessage(detail: AppShowMessageDetail): void | Promise<void>
    /**
     * `showSession`: the task tab opens the session's row, as a tap on it does — or, listed nowhere, the machines whose
     * lists were not read (`listedSession`).
     */
    showSession(sessionId: string, peek: boolean): { shown: true } | { unread: string[] }
    /** 「用 X 打开」 resolved: the slot opens that App on the file, or asks when several claim it. */
    openWith(detail: AppOpenWithDetail): void
    /** G1 Beside the page, over its frame: the frame stays as it was, for the way back. A host without it refuses a peek. */
    peek?(target: PeekTarget): void
    /** `setTabTitle` / `setTabBadge`: drawn on the header of the slot the App is in (摩擦单 F13). */
    chrome(detail: { title?: string | null; badge?: string | number | null; error?: string | null }): void
  },
): { pageId: number; update(binding: PhoneAppBinding): void; filesChanged(changes: readonly { chatId: string; itemIds: readonly string[] }[]): Promise<void>; membersChanged(changes: readonly MemberChange[]): void; command(commandId: string): void; programNotified(notification: { server: string; method: string; params?: unknown }): void; dispose(): void } {
  const pageId = nextPageId++
  const modalHosts = new Map<ReturnType<typeof hostAppFrame>, PhoneAppBinding>()
  // Only ever the App's own document, both ways (appOrigin.ts).
  const channel = appFrameChannel(frame)
  // The sync port waits here until the frame's runtime says it listens ('sync-port'), in either
  // order: posted earlier it would be lost and `files.open(…)` would never settle (摩擦单 F28).
  let heldPort: MessagePort | null = null
  let portWanted = false
  const handOverPort = () => {
    if (!heldPort || !portWanted) return
    if (channel.post(SYNC_PORT_WINDOW_MESSAGE, [heldPort])) heldPort = null
  }

  const hosted: HostedFrame = {
    frame,
    binding: granted(initial),
    deliver: (event) => { channel.post({ m: APP_FRAME_MARKER, t: 'event', event }) },
    syncPage() {
      const existing = relay.page(pageId)
      if (existing) return existing
      const target = frame.contentWindow
      if (!target) throw new AppFileError('failed', 'This surface is gone')
      const { port1, port2 } = new MessageChannel()
      const page = relay.attachPage(pageId, hosted.binding.extensionId, {
        post: (message) => port1.postMessage(message),
        close: () => port1.close(),
      })
      port1.onmessage = (event) => relay.fromPage(page, event.data)
      port1.start()
      heldPort = port2
      handOverPort()
      return page
    },
  }
  frames.set(pageId, hosted)

  const send = (message: HostToFrame) => channel.post(message)
  /** This page's forum subscriptions (`gugu.forum.onChanged`), by post id or 'feed': gone with the page. */
  const forumWatches = new Map<string, () => void>()
  const event = (hostEvent: ExtensionHostEvent) => send({ m: APP_FRAME_MARKER, t: 'event', event: hostEvent })
  /** The page, and the one chat file the host handed it (`ctx.file`): every call names its own target (真源原则 13). */
  const surface = (): FileSurface => ({
    pageId,
    extensionId: hosted.binding.extensionId,
    itemId: hosted.binding.itemId ?? null,
  })
  /** Who is in the chat the page is drawn for (摩擦单 F36): read when the frame first asks, again when the members change. */
  let members: ExtensionMember[] | null = null
  /** And the chat itself (`getContext().chat`), read with them; undefined until read — `files.chat()` throws when it cannot be. */
  let chat: ExtensionChat | null | undefined
  const readMembers = async () => {
    const chatId = hosted.binding.chatId ? await files.resourceChat(hosted.binding.chatId) : null
    hosted.binding.chatId = chatId
    // A page in a session is in no chat: its context says so (no `chat`), never a chat read for nothing.
    if (!chatId) {
      members = []
      chat = null
      return
    }
    try {
      members = await files.members(chatId)
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, 'chat members could not be read')
    }
    chat = await files.chat(chatId)
  }
  /** The chats this page asked to hear about (`files.onChanged({ chat }, fn)`): a phone has no working copies. */
  let watched = new Map<string, { named: string; source: string }>()
  /** A chat's files read for the page (#7257), one read at a time per chat; a failed one's ids go with the next. */
  const readFiles = coalescedReads((chatId, error) =>
    log.error({ error: error instanceof Error ? error.message : String(error), chatId }, 'reading the files a revision named failed twice; they go with its next read'),
  )
  const readChanged = (chatId: string, ids: readonly string[]): Promise<void> =>
    readFiles.want(chatId, ids, async (wanted) => {
      const change = await files.groupChange(chatId, wanted)
      if (hosted.binding.capabilities.includes('files:read') && (change.entries.length > 0 || change.gone.length > 0)) {
        for (const [watchId, { named, source }] of watched) if (source === chatId) event({ type: 'filesChanged', watchId, place: { chat: named }, change: { kind: 'entries', ...change } })
      }
    })
  const peek = (target: PeekTarget) => {
    if (!hooks.peek) refused('invalid', 'Nothing opens beside this page here')
    hooks.peek(target)
  }
  /** A chat file a call names: a phone has no session's working copy to reach. */
  const chatRef = (value: unknown): ChatFileRef => {
    const ref = fileRefOf(value)
    if (isLocal(ref)) refused('not-found', 'A phone has no folders of a computer (session working copies, projects): only chat files')
    return ref as ChatFileRef
  }
  const chatPlace = (value: unknown): string => {
    const place = placeOf(value)
    if (isLocal(place)) refused('not-found', 'A phone has no folders of a computer (session working copies, projects): only chat files')
    return (place as { chat: string }).chat
  }
  const unread = (error: unknown) => log.warn({ error: error instanceof Error ? error.message : String(error) }, 'the chat could not be read')
  const contextOf = (): ExtensionHostContext => ({
    apiVersion: EXTENSION_API_VERSION,
    tabId: hosted.binding.tabId,
    ...(hosted.binding.modal ? { modal: { data: hosted.binding.modal.data } } : {}),
    ...(chat ? { chat: { ...chat, members: members ?? [] } } : {}),
    ...(hosted.binding.itemId && hosted.binding.chatId ? { file: { chat: hosted.binding.chatId, id: hosted.binding.itemId } } : {}),
    ...(hosted.binding.session
      ? {
          session: {
            id: hosted.binding.session.id,
            deviceId: hosted.binding.session.deviceId,
            ...(hosted.binding.session.deviceLabel ? { deviceLabel: hosted.binding.session.deviceLabel } : {}),
            ...(hosted.binding.session.projectId ? { projectId: hosted.binding.session.projectId } : {}),
          },
        }
      : {}),
    // A page on the phone is the person's to work: no agent opens one there (owner 10-14).
    operator: { kind: 'person' },
    locale: hosted.binding.locale,
    themeMode: hosted.binding.themeMode,
    capabilities: hosted.binding.capabilities.filter((capability) => PHONE_CAPABILITIES.includes(capability)),
    layout: { visible: true, fullscreen: Boolean(hosted.binding.modal), width: frame.clientWidth, height: frame.clientHeight },
  })

  /** `gesture` was read when the call arrived: the frame's tap activates this page too (L1, WebView 113/133). */
  const answer = async (method: string, args: Record<string, unknown>, gesture: boolean): Promise<unknown> => {
    // Once, from the verb's row (BRIDGE_VERBS), in the words every host says it — a phone frame is a page.
    const refusal = callRefusal(method, args, { kind: 'page', has: (capability) => hosted.binding.capabilities.includes(capability), gesture })
    if (refusal) refused(refusal.code, refusal.message)
    const session = hosted.binding.session
    if ((session || args.device !== undefined) && verbFacts(method)?.machine) {
      const manifest = installedExtensionsStore.manifestFor(hosted.binding.extensionId)
      if (!manifest) refused('not-installed', `${hosted.binding.extensionId} is not installed on this phone`)
      if (args.device !== undefined) {
        const invalid = notOnSessionMachine(manifest, method, args)
        if (invalid) throw invalid
        const { device, ...callArgs } = args
        return callOnComputer({ extensionId: manifest.id, extensionName: manifest.name, version: manifest.version }, { deviceId: appDeviceId(device), deviceLabel: null }, method, callArgs)
      }
      if (session && followsSessionMachine(manifest, method, args)) {
        return callOnComputer({ extensionId: manifest.id, extensionName: manifest.name, version: manifest.version }, session, method, args)
      }
    }
    switch (method) {
      case 'linkTo': {
        const manifest = installedExtensionsStore.manifestFor(hosted.binding.extensionId)
        if (!manifest) refused('not-installed', 'This App is not installed')
        const target = linkTargetOf(args, manifest)
        return guguLink(target, args.external === true || (target.kind !== 'chat' && target.kind !== 'file') ? phoneLinkScheme() : undefined)
      }
      case 'openLink': {
        const result = await openPhoneLink(typeof args.url === 'string' ? args.url : '')
        if (result.kind !== 'opened') refused(result.kind === 'failed' ? 'failed' : 'invalid', result.kind === 'failed' ? result.detail ?? result.reason : 'Only gugu resource links open here')
        return undefined
      }
      case 'modalOpen': {
        const modal = phoneModals.open(pageId, { ...hosted.binding }, args)
        try {
          const manifest = installedExtensionsStore.manifestFor(hosted.binding.extensionId)
          if (!manifest) refused('not-installed', 'This App is no longer installed')
          const focus = (edge: AppModalFocus) => {
            const child = modal.child === null ? undefined : frames.get(modal.child)
            child?.frame.focus()
            if (child) appFrameChannel(child.frame).post({ m: APP_FRAME_MARKER, t: 'event', event: { type: 'modalFocus', edge } } satisfies HostToFrame)
          }
          showAppModal({
            id: modal.id, title: modal.options.title, appName: localizedManifestText(manifest, hosted.binding.locale).name,
            size: modal.options.size, url: phoneApps.pageUrl(hosted.binding.extensionId, modal.options.entry),
            ...(modal.binding.session ? { frameName: APP_SESSION_FRAME_NAME } : {}),
            opener: frame, focus, dismiss: (error) => phoneModals.close(modal.id, null, error),
            attach(element) {
              const childFrame = element as HTMLIFrameElement
              const childBinding = { ...modal.binding, modal: { id: modal.id, data: modal.options.data } }
              const childHost = hostAppFrame(childFrame, childBinding, {
                ...hooks,
                // The content page's initial hello must not clear its opener's title, badge or error.
                chrome(detail) { if (detail.error) hooks.chrome({ error: detail.error }) },
              })
              modalHosts.set(childHost, childBinding)
              phoneModals.bind(modal.id, childHost.pageId)
              const ready = () => focus('first')
              childFrame.addEventListener('load', ready)
              return () => { childFrame.removeEventListener('load', ready); modalHosts.delete(childHost); childHost.dispose() }
            },
          })
        } catch (error) {
          await phoneModals.close(modal.id, null, error instanceof Error ? error.message : String(error))
        }
        return phoneModals.result(modal)
      }
      case 'modalClose':
        return phoneModals.close(phoneModals.forPage(pageId).id, args.result ?? null)
      case 'modalKey': {
        const modal = phoneModals.forPage(pageId)
        if (args.key !== 'tab') refused('invalid', 'Unknown modal keyboard action')
        focusAppModalClose(modal.id)
        return undefined
      }
      case 'getAppState':
        return phoneAppState(hosted.binding.capabilities)
      case 'getContext':
        // A pill's place waiting for this page goes first, whatever the answer: the frame holds it until `onLink`.
        for (const link of takeOpeningLinks(hosted.binding)) event(link)
        // The members and the chat come with the first answer (not a moment later). The chat unread is said (the files
        // API's own error), never left out: no `chat` would tell the App it is not in one.
        return (chat !== undefined ? Promise.resolve() : readMembers()).then(contextOf)
      case 'reportError': {
        const message = String(args.message ?? '').slice(0, 500)
        const hint = args.level === 'hint'
        log.error({ extensionId: hosted.binding.extensionId, message, level: hint ? 'hint' : 'error' }, 'App reported an error')
        // The slot says the App has an error, as on the desktop (摩擦单 F63) — not for a hint (F62).
        if (!hint) hooks.chrome({ error: message })
        return Promise.resolve(undefined)
      }
      case 'setTabTitle':
        hooks.chrome({ title: pageArgument('setTabTitle', args) })
        return Promise.resolve(undefined)
      case 'setTabBadge':
        hooks.chrome({ badge: pageArgument('setTabBadge', args) })
        return Promise.resolve(undefined)
      case 'openBrowserTab': {
        const url = String(args.url ?? '')
        if (!/^https?:\/\//i.test(url)) refused('invalid', 'openBrowserTab takes an http(s) URL')
        window.open(url, '_blank', 'noopener,noreferrer')
        return Promise.resolve(undefined)
      }
      case 'clipboardWriteText':
        return navigator.clipboard.writeText(pageArgument('clipboardWriteText', args))
      case 'listAgents': {
        const manifest = installedExtensionsStore.manifestFor(hosted.binding.extensionId)
        if (!manifest) refused('not-installed', 'This App is not installed')
        const dispatch = phoneDispatch({ extensionId: manifest.id, extensionName: manifest.name }, hosted.binding.capabilities, {})
        return args.report === true ? dispatch.listAgents(true) : dispatch.listAgents()
      }
      case 'dispatch': {
        const manifest = installedExtensionsStore.manifestFor(hosted.binding.extensionId)
        if (!manifest) refused('not-installed', 'This App is not installed')
        const { agents, local, spawnOn } = phoneDispatch({ extensionId: manifest.id, extensionName: manifest.name }, hosted.binding.capabilities,
          { deviceId: hosted.binding.session?.deviceId, chatId: hosted.binding.chatId, agents: members?.filter((member) => member.kind === 'agent').map((member) => member.id) })
        return dispatchFromApp(
          {
            ...sendPlatform,
            agents,
            pick: pickDispatchTarget,
            // Use the same capture-before-append ordering as the desktop host.
            draftInChat: async (detail) => void document.dispatchEvent(new CustomEvent<AppComposeDetail>(APP_COMPOSE_EVENT, { detail, bubbles: true })),
          },
          hosted.binding.extensionId,
          args,
          { chat: chat ? { id: chat.id, name: chat.name, members: members ?? [] } : null, preselect: null, local, spawnOn },
        )
      }
      case 'messagesHistory':
        return messagesForApp.history(args)
      case 'messagesSearch':
        return messagesForApp.search(args)
      // The chats this person is in, and who is in one: the desktop's answer (`app-files-core.ts`).
      case 'chatsList':
        return files.chats().then((chats) => ({ chats }))
      case 'chatsMembers':
        return Promise.resolve().then(() => files.members(chatOf(args))).then((members) => ({ members }))
      // 论坛 (9): as the person; a bounty's points move only behind the shell's own sheet.
      case 'forumList':
        return forumForApp.list(args)
      case 'forumRead':
        return forumForApp.read(args.postId)
      case 'forumReply':
        return forumForApp.reply(args.postId, args.text, { replyTo: args.replyTo })
      case 'forumReact':
        return forumForApp.react(args)
      case 'forumRemove':
        return forumForApp.remove(args)
      case 'forumBlock':
        return forumForApp.block(args.userId, args.on)
      case 'forumAssign':
        return forumForApp.assign(args.postId, args.agentId, pickDispatchTarget)
      case 'forumPost':
        return args.bounty === undefined || args.bounty === null
          ? forumForApp.postPlain(args)
          : Promise.resolve().then(() => askForumConsent({ type: 'bounty', draft: forumForApp.bountyDraft(args) }))
      case 'forumAward':
        return forumForApp.awardDraft(args.postId, args.awards).then((draft) => askForumConsent({ type: 'award', draft }))
      case 'forumSubscribe':
        return Promise.resolve().then(() => {
          const target = String(args.target ?? '')
          if (!forumWatches.has(target)) forumWatches.set(target, forumForApp.watch(args.target, (change) => event({ type: 'forumChanged', target, change })))
        })
      case 'forumUnsubscribe': {
        const target = String(args.target ?? '')
        forumWatches.get(target)?.()
        forumWatches.delete(target)
        return Promise.resolve(undefined)
      }
      case 'showMessage':
        return files.messageToShow(args as never).then((detail) => hooks.showMessage(detail))
      case 'showSession': {
        if (args.peek === true && !hooks.peek) refused('invalid', 'Nothing opens beside this page here')
        // The session as the task tab lists it, on any of the person's computers (the phone has none of its own); listed
        // nowhere is the answer only when every computer's list was read.
        const sessionId = sessionIdOf(args.id)
        const shown = hooks.showSession(sessionId, args.peek === true)
        if ('unread' in shown) {
          const tail = shown.unread.length ? ` (not read: ${shown.unread.join(', ')})` : ''
          refused(shown.unread.length ? 'failed' : 'not-found', `Session ${sessionId} is not in your task list${tail}`)
        }
        return Promise.resolve(undefined)
      }
      case 'filesOpenWith':
        return files.openTarget(surface(), { ref: chatRef(args.ref) }).then((target) => {
          const choice = openerChoice(target.typedName, appsHereNow(), 'chat', phoneApps.remembered, args.ask === true)
          // A pill in the page: its place, for the page about to open the file — as a file link in the chat (`groupFileOpener`).
          const place = placeFor(choice, args.at)
          if (place) holdPlaceForOpeningPage(target.chatId, target.itemId, place.candidate, place.at)
          // Beside the page: a file nobody here opens shows in the host's preview there.
          if (args.peek === true) return peek({ kind: 'chat', detail: { ...target, choice } })
          hooks.openWith({ ...target, choice })
        })
      case 'filesOpen':
        return files.open(surface(), { ref: chatRef(args.ref), ...(args.readOnly === true ? { readOnly: true } : {}), deferDetails: args.deferDetails === true })
      case 'filesReopen': {
        const ref = chatRef(args.ref)
        if (!('id' in ref)) refused('invalid', 'reopen takes a file by its id')
        return files.reopen(surface(), { ref: ref as Extract<ChatFileRef, { id: string }>, ...(args.readOnly === true ? { readOnly: true } : {}) })
      }
      case 'filesClose':
        return Promise.resolve(files.close(surface(), args as never))
      case 'filesList':
        return files.groupFiles(chatPlace(args.place), typeof args.folder === 'string' ? { folder: args.folder } : {})
      case 'filesSearch':
        return Promise.resolve().then(() => files.search(fileSearchOf(args)))
      case 'filesRecent':
        return Promise.resolve().then(() => {
          const { limit } = fileSearchOf(args)
          return files.recent(limit === undefined ? {} : { limit })
        })
      case 'filesCreate':
        return files.create(chatPlace(args.place), args as never)
      case 'filesRename':
        return files.rename(surface(), { ref: chatRef(args.ref), name: String(args.name ?? '') })
      case 'filesMkdir':
        return files.mkdir(chatPlace(args.place), { path: args.path })
      case 'filesMove':
        return files.move(surface(), { ref: chatRef(args.ref), folder: args.folder, name: args.name })
      case 'filesRemove':
        return files.remove(surface(), { ref: chatRef(args.ref) })
      case 'filesReplace':
        return files.replace(surface(), { ref: chatRef(args.ref), file: args.file as AppFileUpload, expectedVersion: (args.expectedVersion ?? null) as number | null })
      case 'filesVersions':
        return files.versions(surface(), { ref: chatRef(args.ref) })
      case 'filesReadVersion':
        return files.readVersion(surface(), { ref: chatRef(args.ref), n: Number(args.n) })
      case 'filesWatch': {
        if (typeof args.watchId !== 'string' || !args.watchId) refused('invalid', 'A file watch needs its subscription id')
        const named = chatPlace(args.place)
        if (args.on === false) {
          const existing = watched.get(args.watchId)
          watched.delete(args.watchId)
          if (existing && ![...watched.values()].some(({ source }) => source === existing.source)) readFiles.forget(existing.source)
        } else {
          const documentWatches = watched
          const source = await files.resourceChat(named)
          if (watched !== documentWatches) return
          if (documentWatches.has(args.watchId)) refused('invalid', 'This file watch is already registered')
          documentWatches.set(args.watchId, { named, source })
        }
        return Promise.resolve(undefined)
      }
      case 'filesUpload': {
        const chatId = chatPlace(args.place)
        if (args.pick === true) {
          // Opened now, in this very turn: the picker needs the person's activation.
          return pickFiles().then((picked) => (picked.length === 0 ? [] : files.upload(chatId, picked, { sourceMessageIds: args.sourceMessageIds, folder: args.folder })))
        }
        if (!Array.isArray(args.files)) refused('invalid', 'files.upload takes files, or none to pick')
        return files.upload(chatId, args.files as AppFileUpload[], { sourceMessageIds: args.sourceMessageIds, folder: args.folder })
      }
      case 'filesDownload':
        return files.downloadSource(surface(), { ref: chatRef(args.ref) }).then(async (source) => {
          // The one save every 「保存」 takes (platform.saveFile: the system's 「保存到…」 on the phone), under the file's
          // own name — a file in OSS has a link named by its hash (#7290). Cancelled in the system picker = false.
          const blob = source.kind === 'file' ? await fileBlob(source.file) : new Blob([source.text], { type: 'text/plain;charset=utf-8' })
          return (await platform.saveFile(blob, source.name)).saved
        })
      // The App's own data folder and program: in a session they are its computer's (owner 10-16「程序跟着数据」), done
      // THERE; in a chat the data folder is the phone's own, and a phone runs no program.
      case 'callProgram':
        // In a session only a program gugu hosts gets here: it drives the screen the page is on, and a phone hosts none (161 10-17).
        return refused('invalid', session ? HOSTED_PROGRAM_ELSEWHERE : 'Not available on the phone: callProgram (a phone runs no program; a page in a session calls its computer\'s)')
      case 'readData':
        return phoneApps.data.read(hosted.binding.extensionId, typeof args.path === 'string' ? args.path : '')
      case 'listData':
        return phoneApps.data.list(hosted.binding.extensionId, typeof args.path === 'string' ? args.path : '.')
      case 'writeData':
        if (typeof args.content !== 'string') refused('invalid', 'content must be a string')
        return phoneApps.data.write(hosted.binding.extensionId, typeof args.path === 'string' ? args.path : '', args.content as string)
      default:
        return refused('invalid', `Not available on the phone: ${method}`)
    }
  }

  let documentStarted = false
  const onMessage = (messageEvent: MessageEvent) => {
    if (!channel.accepts(messageEvent)) return
    const message = messageEvent.data as FrameToHost | null
    if (!message || message.m !== APP_FRAME_MARKER) return
    // A new document in the frame (a reload, or the App moving to another of its pages): the old one's open files end as
    // if it had closed, and its port with it — the new one asks for its own. Told by the new document's runtime, ahead of
    // its first call (main's `did-navigate` on the desktop).
    // @@@hello-not-load - not the frame's `load`: it fires after the new document's scripts, which have already opened a
    // file on the old page by then (and the first one can come before this host listens). A page without the runtime
    // leaves the old grants until the next document's hello or `dispose`: nothing reaches them, the port's far end is gone.
    // What the old document said about itself (title, badge, error) goes with it: the new one starts from the manifest's
    // title, as main's `newDocument` on the desktop (extension-bridge.ts `sayAboutPage`).
    if (message.t === 'hello') {
      if (documentStarted) void phoneModals.pageGone(pageId)
      documentStarted = true
      for (const { source } of watched.values()) readFiles.forget(source)
      watched = new Map()
      relay.pageGone(pageId)
      heldPort = null
      portWanted = false
      hooks.chrome({ title: null, badge: null, error: null })
      return
    }
    if (message.t === 'sync-port') {
      portWanted = true
      handOverPort()
      return
    }
    if (message.t !== 'call') return
    // Read now, not after anything is queued: the activation lasts ~5 s (L1).
    const gesture = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === true
    let result: Promise<unknown>
    try {
      result = answer(message.method, (message.args ?? {}) as Record<string, unknown>, gesture)
    } catch (error) {
      result = Promise.reject(error)
    }
    result.then(
      (value) => send({ m: APP_FRAME_MARKER, t: 'result', id: message.id, ok: true, value }),
      (error: unknown) => send({ m: APP_FRAME_MARKER, t: 'result', id: message.id, ok: false, ...bridgeFailure(error) }),
    )
  }
  window.addEventListener('message', onMessage)
  let lastState = JSON.stringify(phoneAppState(hosted.binding.capabilities))
  const stateChanged = () => {
    const state = phoneAppState(hosted.binding.capabilities)
    const next = JSON.stringify(state)
    if (next !== lastState) { lastState = next; event({ type: 'appState', state }) }
  }
  const snapshot = () => new Map(cachedPhoneAgents(hosted.binding.extensionId, hosted.binding.capabilities).map((agent) => [agent.agentId, JSON.stringify(agent)]))
  let previous = snapshot()
  const stopState = onPhoneAppState(stateChanged)
  const stopAgents = subscribeDeviceSessions(() => {
    stateChanged()
    const next = snapshot()
    const changed = [...new Set([...previous.keys(), ...next.keys()])].filter((id) => previous.get(id) !== next.get(id))
    previous = next
    if (hosted.binding.capabilities.includes('agents:read') && changed.length) event({ type: 'agentsChanged', agentIds: changed })
  })

  return {
    pageId,
    update(binding) {
      const moved = binding.chatId !== hosted.binding.chatId || (binding.itemId ?? null) !== (hosted.binding.itemId ?? null)
      // Another group, or another handed-over file: the open files it could enter were the old ones'.
      if (moved) relay.revoke(pageId, 'unbound')
      hosted.binding = granted(binding)
      previous = snapshot()
      stateChanged()
      // Reuse the parent's existing subscriptions and host events for its sandboxed modal pages too.
      for (const [childHost, childBinding] of modalHosts) childHost.update({ ...childBinding, locale: binding.locale, themeMode: binding.themeMode, capabilities: binding.capabilities })
      // Moved to a file a pill is waiting to open: its place is this page's now (after the context that names the file).
      const placed = () => { if (moved) for (const link of takeOpeningLinks(hosted.binding)) event(link) }
      // The theme is part of it: the page's ui.js picks its palette from context.themeMode.
      if (!moved) return event({ type: 'context', context: contextOf() })
      // Another chat: its members and the chat itself are read again before the page is told.
      members = null
      chat = undefined
      // The place goes whether or not the members could be read (the page is on that file either way).
      void readMembers().then(() => event({ type: 'context', context: contextOf() }), unread).then(placed)
    },
    /** These chats' files changed (the account revision bus names them): the ones the page asked about are told how those files are now. */
    filesChanged(changes) {
      const children = [...modalHosts.keys()].map((childHost) => childHost.filesChanged(changes))
      if (!hosted.binding.capabilities.includes('files:read')) return Promise.all(children).then(() => undefined)
      return Promise.all([...children, ...changes.filter(({ chatId }) => [...watched.values()].some(({ source }) => source === chatId)).map(({ chatId, itemIds }) => readChanged(chatId, itemIds))]).then(() => undefined)
    },
    /** Rows of the chat's members changed (the account revision bus): when that moved who is there, the frame is told. */
    membersChanged(changes) {
      for (const childHost of modalHosts.keys()) childHost.membersChanged(changes)
      if (!rosterMoved(members ?? null, changes)) return
      void readMembers().then(() => event({ type: 'context', context: contextOf() }), unread)
    },
    /** One of the tab's declared toolbar / menu entries, picked on the slot's header (摩擦单 F13). */
    command(commandId) {
      event({ type: 'command', commandId })
    },
    /** owner 10-16 The App's program on the session's computer sent a notification (`onProgramNotification`). */
    programNotified(notification) {
      for (const childHost of modalHosts.keys()) childHost.programNotified(notification)
      event({ type: 'programNotification', server: notification.server, method: notification.method, ...(notification.params === undefined ? {} : { params: notification.params }) })
    },
    dispose() {
      stopState()
      stopAgents()
      void phoneModals.pageGone(pageId)
      for (const { source } of watched.values()) readFiles.forget(source)
      watched = new Map()
      for (const stop of forumWatches.values()) stop()
      forumWatches.clear()
      window.removeEventListener('message', onMessage)
      relay.pageGone(pageId)
      frames.delete(pageId)
    },
  }
}


declare const __GUGU_TIER__: string
const phoneLinkScheme = () => guguLinkScheme({ tier: typeof __GUGU_TIER__ === 'undefined' ? undefined : __GUGU_TIER__, devLaunch: false })

/** Host facts and transports only; target parsing and opening order are shared with main. */
export async function openPhoneLink(target: string | GuguLinkTarget) {
  if (platform.kind === 'capacitor') await phoneApps.ready()
  return openLinkWith({
    installed: () => installedExtensionsStore.manifests.map((manifest) => ({ manifest })),
    isEnabled: (id) => installedExtensionsStore.isEnabled(id),
    locale: () => document.documentElement.lang,
    resourceChat: async (chatId) => { const { token, userId } = await sendPlatform.account(); return resourceChatIdOf(token, chatId, userId) },
    sessionProject: async (sessionId) => { const listed = listedSession(readCachedDevices(), liveDeviceSessions(), sessionId); return 'row' in listed ? listed.row.session.projectId : null },
    reveal: async ({ sessionId, tabKind }) => {
      const listed = listedSession(readCachedDevices(), liveDeviceSessions(), sessionId)
      if (!('row' in listed)) throw new Error('Session is not in your task list')
      const { APP_SHOW_SESSION_EVENT } = await import('../../session/shared/extensions/app-runtime-protocol')
      window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail: { ...listed.row, tabKind } }))
    },
    openApp: async (extensionId, tab, chatId) => {
      const opened = await openLinkTarget({ kind: 'app', extensionId, tab, path: '', query: {}, place: chatId ? { chat: chatId } : null })
      if (!opened) throw new Error('The App did not open')
      return opened
    },
    openResource: async (resource) => { await openLinkTarget(resource) },
    deliver: (extensionId, event, opened) => {
      const place = opened === 'own' ? null : opened
      openingLinks.push({ extensionId, event, chatId: place && 'chat' in place ? place.chat : null, itemId: null, ...(place && 'session' in place ? { sessionId: place.session } : {}), expiresAt: Date.now() + OPENING_LINK_TTL_MS })
      for (const frame of frames.values()) for (const waiting of takeOpeningLinks(frame.binding)) frame.deliver(waiting)
    },
  }, target)
}
