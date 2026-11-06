import type { TabOpenIntent } from '@shared/view-state'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useMobileShell } from '../../hooks/useMobileShell'
import { chatDb } from '../../lib/supabase'
import { rendererLogger } from '../../lib/log'
import { UI_EVENTS } from '../../lib/uiEvents'
import { isRenderableImage } from '@gugu/core/shared/imageMime.mjs'
import { openAttachmentImage } from '../../lib/attachmentBytes'
import { installedExtensionsStore, WORKSPACE_APP_ID } from '../../session/renderer/features/extensions/installed-extensions-store'
import { APP_OPEN_WITH_EVENT, type AppOpenWithDetail } from '../../session/shared/extensions/app-runtime-protocol'
import { displayNameOf } from '../../session/shared/extensions/file-openers'
import { folderItem, type PanelItem } from '../../session/renderer/features/chats/chat-tabs/chat-panel-item'
import { openPanelItem, chatPaneOf, chatLayoutOf, takeChatAsk, type ChatFileOpenReceipt } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { appsHere } from './appsHere'
import { OpenWithPick } from './OpenWithPick'

const log = rendererLogger('app-slot/group')

/** How an open came: the tab whose page asked (its 上一页), and what closing it hands back (a link's message). */
type OpenFrom = { message?: MessageItem; restore?: () => void; from?: string; intent?: TabOpenIntent; receipt?: ChatFileOpenReceipt }

/**
 * A file the person opened beside a chat (every way in ends here: the folder's list, a link, a card, 「用 X 打开」), kept
 * for them in the database (gugu-supabase 20261017002319) — so what they opened last is the same on every device, and an
 * App's `files.recent` reads it. An App reading a file again, or an agent working a page, is not the person opening it.
 */
function noteOpened(itemId: string): void {
  void import('../../lib/fileAccess').then(async ({ localFileRevision }) => {
    if (await localFileRevision(itemId)) return
    const { error } = await chatDb.rpc('workspace_note_open', { p_item_id: itemId })
    if (error) throw new Error(error.message)
  }).catch(error => log.warn({ itemId, error: String(error) }, 'the open was not kept for 最近打开'))
}

/**
 * The chat on screen answers what was asked of it, every way in (`askChat`: an App, a link's file, a page's
 * `files.openWith`): taken now, or as soon as this chat is the one shown. What opens it is found here — the App that
 * claims the file, the one kept for its kind (「始终用它」), or the person picks — and it opens as a tab beside the chat
 * (`openPanelItem`). The pick, an App's several files and a file that cannot open are said over the chat (`overlay`).
 */
export function useChatOpener(chatId: string | null, onShow?: (chatId: string, tabId: string) => void | Promise<void>, canTake?: () => boolean): { overlay: ReactNode; openWith: (detail: AppOpenWithDetail, from?: string) => void } {
  const { t } = useTranslation('messaging')
  const mobile = useMobileShell()
  const asking = useRef(0)
  const receipts = useRef(new Set<ChatFileOpenReceipt>())
  const canTakeRef = useRef(canTake)
  canTakeRef.current = canTake
  const [prompt, setPrompt] = useState<(AppOpenWithDetail & OpenFrom) | null>(null)
  /** 摩擦单 F51: the files of the App whose card was opened, when there are several. */
  const [appFiles, setAppFiles] = useState<{ chatId: string; appName: string; files: { itemId: string; displayName: string }[] } | null>(null)
  /** Why a file asked for could not be opened (gone, or not this group's): said here, not a click that does nothing. */
  const [unopened, setUnopened] = useState<string | null>(null)
  useEffect(() => {
    setPrompt(null)
    setAppFiles(null)
    setUnopened(null)
  }, [chatId])

  const show = useCallback(async (target: string, item: PanelItem, from: OpenFrom) => {
    const shown = { ...item, ...(from.message ? { message: from.message } : {}) }
    // A pending message is not tab state: neither JSON nor structured-clone snapshots carry it.
    if (item.takeOpening) Object.defineProperty(shown, 'takeOpening', { get: () => item.takeOpening, enumerable: false })
    if (mobile) chatLayoutOf(target).setNarrow(true)
    const tabId = openPanelItem(target, shown, { intent: from.intent ?? 'navigate', ...(from.from ? { from: from.from } : {}), ...(from.restore ? { restore: from.restore } : {}) })
    if (!tabId) throw new Error('The file panel could not be opened')
    await onShow?.(target, tabId)
    if (item.itemId) noteOpened(item.itemId)
  }, [onShow, mobile])

  // The file asked last is the one opened: a pill clicked, then another (or a file in an App's list), before the first's
  // answer is back — whichever answer comes last, the chat ends on the later ask (#7257). Each ask takes the next number.
  const openResolved = useCallback(
    async (detail: AppOpenWithDetail, from: OpenFrom = {}) => {
      if (detail.chatId !== chatId) throw new Error('The file belongs to a different conversation')
      from = { ...from, from: detail.from ?? from.from, intent: detail.intent ?? from.intent }
      if (from.from && detail.viewState) chatPaneOf(detail.chatId, from.from)?.setPageViewState(from.from, detail.viewState)
      if (detail.choice.kind === 'none') {
        if (!from.from && isRenderableImage(detail.name, detail.file.contentType)) {
          await openAttachmentImage({ kind: 'item', itemId: detail.itemId, version: detail.file.version }, detail.name, from.message ? { chatId: from.message.chat_id, messageId: from.message.id } : { chatId: detail.chatId })
          noteOpened(detail.itemId)
          return
        }
        return show(detail.chatId, { kind: null, file: detail.file, itemId: detail.itemId, title: detail.name, typedName: detail.typedName }, from)
      }
      if (detail.choice.kind === 'one') {
        const { candidate } = detail.choice
        let opening = detail.opening
        delete detail.opening
        const takeOpening = () => { const taken = opening; opening = undefined; return taken }
        return show(detail.chatId, { kind: candidate.tabKind, itemId: detail.itemId, title: displayNameOf(detail.name, candidate.suffix), fileName: detail.name, typedName: detail.typedName, takeOpening }, from)
      }
      setPrompt({ ...detail, ...from })
    },
    [chatId, show],
  )
  /**
   * An App asked for a file (its list's click, `files.openWith`), resolved by its host. A file of another chat goes to
   * the chat shell, which brings that chat up and hands it to that chat (MainLayout).
   */
  const openWith = useCallback(
    (detail: AppOpenWithDetail, from?: string) => {
      if (detail.chatId !== chatId) {
        window.dispatchEvent(new CustomEvent<AppOpenWithDetail>(APP_OPEN_WITH_EVENT, { detail }))
        return
      }
      asking.current += 1
      void Promise.resolve(openResolved(detail, from ? { from } : {})).catch(error => setUnopened(String(error)))
    },
    [chatId, openResolved],
  )
  const openGroupFile = useCallback(
    async (itemId: string, at?: Record<string, string>, from: OpenFrom = {}) => {
      if (!appsHere || !chatId) {
        from.receipt?.reject(new Error('The file opener is unavailable'))
        if (from.receipt) receipts.current.delete(from.receipt)
        return
      }
      const asked = ++asking.current
      setUnopened(null)
      try {
        // `at`: the App that opens it gets the place as a `link` event, from the host that resolves who opens it.
        const result = await appsHere.groupFileOpener({ chatId, itemId, ...(at ? { at } : {}) })
        if (asked !== asking.current) throw new Error('The file opening was superseded')
        if (!result.success || !result.data) throw new Error(result.error || 'no answer')
        setUnopened(null)
        setAppFiles(null)
        await openResolved(result.data, from)
        if (asked !== asking.current) throw new Error('The file opening was superseded')
        from.receipt?.resolve()
      } catch (error) {
        // Links report failure to their caller; direct folder clicks retain the
        // inline failure surface without producing a second notice.
        if (asked === asking.current && !from.receipt) setUnopened(String(error) || 'no answer')
        from.receipt?.reject(error)
      } finally {
        if (from.receipt) receipts.current.delete(from.receipt)
      }
    },
    [chatId, openResolved],
  )

  useEffect(() => {
    if (!chatId || !appsHere) return undefined
    let live = true
    const pendingReceipts = receipts.current
    const take = () => {
      if (canTakeRef.current && !canTakeRef.current()) return
      const ask = takeChatAsk(chatId)
      if (!ask) return
      for (const receipt of receipts.current) receipt.reject(new Error('The file opening was superseded'))
      receipts.current.clear()
      // A page beside the chat asked: the tab on screen is the 上一页 of what it opens (owner 10-24).
      const source = 'from' in ask ? ask.from : undefined
      if ('itemId' in ask) {
        if (ask.receipt) receipts.current.add(ask.receipt)
        const from: OpenFrom = { ...(ask.message ? { message: ask.message } : {}), ...(ask.restore ? { restore: ask.restore } : {}), ...(source ? { from: source } : {}), ...(ask.receipt ? { receipt: ask.receipt } : {}) }
        // 「用 X 打开」 its host resolved already (who opens it, or among which to ask): opened as it said — a file of another
        // chat goes to the chat shell, which brings that chat up (MainLayout).
        if (ask.opener && ask.opener.chatId !== chatId) {
          if (ask.receipt) {
            ask.receipt.reject(new Error('The file belongs to a different conversation'))
            receipts.current.delete(ask.receipt)
          } else window.dispatchEvent(new CustomEvent<AppOpenWithDetail>(APP_OPEN_WITH_EVENT, { detail: ask.opener }))
        } else if (ask.opener) {
          asking.current += 1
          void Promise.resolve(openResolved(ask.opener, from)).then(() => ask.receipt?.resolve(), error => { if (!ask.receipt) setUnopened(String(error)); ask.receipt?.reject(error) }).finally(() => { if (ask.receipt) receipts.current.delete(ask.receipt) })
        } else void openGroupFile(ask.itemId, ask.at, from)
        return
      }
      // 「在本群打开」(app-redesign §5), the folder too: what the App opens here is found first, so that one already open is
      // the tab shown (owner 10-24) — the file it names in this chat (`chatFile`), its own page, or where its files are.
      const asked = ++asking.current
      setPrompt(null)
      setUnopened(null)
      setAppFiles(null)
      if (ask.app === WORKSPACE_APP_ID) {
        void Promise.resolve(show(chatId, folderItem(), {})).catch(error => setUnopened(String(error)))
        return
      }
      const page = ask.tab ? installedExtensionsStore.allTabContributions.find((entry) => entry.kind === `${ask.app}.${ask.tab}`) : installedExtensionsStore.mainTabOf(ask.app)
      const namesFile = !ask.tab && installedExtensionsStore.isEnabled(ask.app) && installedExtensionsStore.manifestFor(ask.app)?.contributes.tabs.some((tab) => tab.chatFile)
      if (page?.enabled && !namesFile) {
        void Promise.resolve(show(chatId, { kind: page.kind, title: page.title }, {})).catch(error => setUnopened(String(error)))
        return
      }
      if (namesFile) {
        void appsHere!.appChatFile({ chatId, extensionId: ask.app }).then((result) => {
          if (!live || asked !== asking.current) return
          if (!result.success || !result.data) setUnopened(result.error || 'no answer')
          else void Promise.resolve(openResolved(result.data)).catch(error => setUnopened(String(error)))
        })
      } else {
        void appsHere!.groupFilesOpenedBy({ chatId, extensionId: ask.app }).then((result) => {
          if (!live || asked !== asking.current || !result.success || !result.data) return
          const files = result.data
          if (files.length === 1) void openGroupFile(files[0]!.itemId)
          else if (files.length > 1) setAppFiles({ chatId, appName: installedExtensionsStore.appName(ask.app) ?? ask.app, files })
        })
      }
    }
    take()
    window.addEventListener(UI_EVENTS.chatAsked, take)
    return () => {
      live = false
      ++asking.current
      for (const receipt of pendingReceipts) receipt.reject(new Error('The file opener was closed'))
      pendingReceipts.clear()
      window.removeEventListener(UI_EVENTS.chatAsked, take)
    }
  }, [chatId, openGroupFile, openResolved, show])

  const content = chatId && (prompt?.choice.kind === 'choose' || unopened || (appFiles && appFiles.chatId === chatId)) ? (
    <div className="flex flex-col gap-3 !p-4" data-testid="group-app-open-with-sheet">
      {unopened ? (
        <div className="flex items-center gap-2 text-[length:var(--font-caption)] text-[var(--text-error)]" data-testid="group-app-slot-unopened">
          {/* Why is in main's log; the person reads what can be the case here. */}
          <span className="min-w-0 flex-1">{t('chatArea.openWith.fileUnavailable')}</span>
          <Button size="sm" variant="ghost" onClick={() => setUnopened(null)}>{t('common.close')}</Button>
        </div>
      ) : null}
      {appFiles && appFiles.chatId === chatId ? (
        <div className="flex flex-col items-stretch gap-1" data-testid="group-app-slot-app-files">
          <div className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t('chatArea.openWith.appFiles', { name: appFiles.appName })}</div>
          {appFiles.files.map((file) => (
            <Button key={file.itemId} size="sm" variant="ghost" className="justify-start" data-app-file={file.itemId} onClick={() => void openGroupFile(file.itemId)}>
              {file.displayName}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setAppFiles(null)}>{t('common.cancel')}</Button>
        </div>
      ) : null}
      {prompt && prompt.choice.kind === 'choose' ? (
        <OpenWithPick
          detail={{ ...prompt, choice: prompt.choice }}
          onCancel={() => setPrompt(null)}
          onPick={(candidate) => {
            setPrompt(null)
            void Promise.resolve(show(prompt.chatId, { kind: candidate.tabKind, itemId: prompt.itemId, title: displayNameOf(prompt.name, candidate.suffix), fileName: prompt.name, typedName: prompt.typedName }, prompt)).catch(error => setUnopened(String(error)))
          }}
        />
      ) : null}
    </div>
  ) : null
  // A phone's folder/App fills the screen: the pick belongs above that page, in the shared Back stack.
  const overlay = !content ? null : mobile ? (
    <Sheet mobileFitContent onClose={() => { setPrompt(null); setAppFiles(null); setUnopened(null) }}>{content}</Sheet>
  ) : (
    <div className="absolute inset-x-0 top-0 z-30 border-b border-[var(--border)] bg-[var(--bg-primary)] shadow-lift">{content}</div>
  )

  return { overlay, openWith }
}
