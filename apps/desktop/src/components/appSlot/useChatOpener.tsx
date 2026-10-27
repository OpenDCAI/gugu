import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useMobileShell } from '../../hooks/useMobileShell'
import { chatDb } from '../../lib/supabase'
import { rendererLogger } from '../../lib/log'
import { UI_EVENTS } from '../../lib/uiEvents'
import { installedExtensionsStore, WORKSPACE_APP_ID } from '../../session/renderer/features/extensions/installed-extensions-store'
import { APP_OPEN_WITH_EVENT, type AppOpenWithDetail } from '../../session/shared/extensions/app-runtime-protocol'
import { displayNameOf } from '../../session/shared/extensions/file-openers'
import { folderItem, type PanelItem } from '../../session/renderer/features/chats/chat-tabs/chat-panel-item'
import { openPanelItem, shownPanelTab, takeChatAsk } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { appsHere } from './appsHere'
import { OpenWithPick } from './OpenWithPick'

const log = rendererLogger('app-slot/group')

/** How an open came: the tab whose page asked (its 上一页), and what closing it hands back (a link's message). */
type OpenFrom = { message?: MessageItem; restore?: () => void; returnTo?: string }

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
export function useChatOpener(chatId: string | null): { overlay: ReactNode; openWith: (detail: AppOpenWithDetail, returnTo?: string) => void } {
  const { t } = useTranslation('messaging')
  const mobile = useMobileShell()
  const asking = useRef(0)
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

  const show = useCallback((target: string, item: PanelItem, from: OpenFrom) => {
    const shown = { ...item, ...(from.message ? { message: from.message } : {}) }
    // A pending message is not tab state: neither JSON nor structured-clone snapshots carry it.
    if (item.takeOpening) Object.defineProperty(shown, 'takeOpening', { get: () => item.takeOpening, enumerable: false })
    openPanelItem(target, shown, { ...(from.returnTo ? { returnTo: from.returnTo } : {}), ...(from.restore ? { restore: from.restore } : {}) })
    if (item.itemId) noteOpened(item.itemId)
  }, [])

  // The file asked last is the one opened: a pill clicked, then another (or a file in an App's list), before the first's
  // answer is back — whichever answer comes last, the chat ends on the later ask (#7257). Each ask takes the next number.
  const openResolved = useCallback(
    (detail: AppOpenWithDetail, from: OpenFrom = {}) => {
      if (detail.chatId !== chatId) return
      if (detail.choice.kind === 'none') {
        show(detail.chatId, { kind: null, file: detail.file, itemId: detail.itemId, title: detail.name, typedName: detail.typedName }, from)
        return
      }
      if (detail.choice.kind === 'one') {
        const { candidate } = detail.choice
        let opening = detail.opening
        delete detail.opening
        const takeOpening = () => { const taken = opening; opening = undefined; return taken }
        show(detail.chatId, { kind: candidate.tabKind, itemId: detail.itemId, title: displayNameOf(detail.name, candidate.suffix), fileName: detail.name, typedName: detail.typedName, takeOpening }, from)
        return
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
    (detail: AppOpenWithDetail, returnTo?: string) => {
      if (detail.chatId !== chatId) {
        window.dispatchEvent(new CustomEvent<AppOpenWithDetail>(APP_OPEN_WITH_EVENT, { detail }))
        return
      }
      asking.current += 1
      openResolved(detail, returnTo ? { returnTo } : {})
    },
    [chatId, openResolved],
  )
  const openGroupFile = useCallback(
    async (itemId: string, at?: Record<string, string>, from: OpenFrom = {}) => {
      if (!appsHere || !chatId) return
      const asked = ++asking.current
      // `at`: the App that opens it gets the place as a `link` event, from the host that resolves who opens it.
      const result = await appsHere.groupFileOpener({ chatId, itemId, ...(at ? { at } : {}) })
      if (asked !== asking.current) return
      if (!result.success || !result.data) {
        // Never empty: an empty reason would read as "nothing to say" and the line would not show.
        setUnopened(result.error || 'no answer')
        return
      }
      setUnopened(null)
      setAppFiles(null)
      openResolved(result.data, from)
    },
    [chatId, openResolved],
  )

  useEffect(() => {
    if (!chatId || !appsHere) return undefined
    let live = true
    const take = () => {
      const ask = takeChatAsk(chatId)
      if (!ask) return
      // A page beside the chat asked: the tab on screen is the 上一页 of what it opens (owner 10-24).
      const returnTo = 'fromPage' in ask ? shownPanelTab(chatId)?.tabId : undefined
      if ('itemId' in ask) {
        const from: OpenFrom = { ...(ask.message ? { message: ask.message } : {}), ...(ask.restore ? { restore: ask.restore } : {}), ...(returnTo ? { returnTo } : {}) }
        // 「用 X 打开」 its host resolved already (who opens it, or among which to ask): opened as it said — a file of another
        // chat goes to the chat shell, which brings that chat up (MainLayout).
        if (ask.opener && ask.opener.chatId !== chatId) {
          window.dispatchEvent(new CustomEvent<AppOpenWithDetail>(APP_OPEN_WITH_EVENT, { detail: ask.opener }))
        } else if (ask.opener) {
          asking.current += 1
          openResolved(ask.opener, from)
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
        show(chatId, folderItem(), {})
        return
      }
      const page = ask.tab ? installedExtensionsStore.allTabContributions.find((entry) => entry.kind === `${ask.app}.${ask.tab}`) : installedExtensionsStore.mainTabOf(ask.app)
      const namesFile = !ask.tab && installedExtensionsStore.isEnabled(ask.app) && installedExtensionsStore.manifestFor(ask.app)?.contributes.tabs.some((tab) => tab.chatFile)
      if (page?.enabled && !namesFile) {
        show(chatId, { kind: page.kind, title: page.title }, {})
        return
      }
      if (namesFile) {
        void appsHere!.appChatFile({ chatId, extensionId: ask.app }).then((result) => {
          if (!live || asked !== asking.current) return
          if (!result.success || !result.data) setUnopened(result.error || 'no answer')
          else openResolved(result.data)
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
            show(prompt.chatId, { kind: candidate.tabKind, itemId: prompt.itemId, title: displayNameOf(prompt.name, candidate.suffix), fileName: prompt.name, typedName: prompt.typedName }, prompt)
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
