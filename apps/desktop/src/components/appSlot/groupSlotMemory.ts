import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { PanelForm, SidePanelWidths } from '../../session/renderer/lib/layout/side-panel-split'
import { extensionSurfaceStore } from '../../session/renderer/features/extensions/extension-surface-store'
import { WORKSPACE_APP_ID } from '../../session/renderer/features/extensions/installed-extensions-store'
import type { AppOpenWithDetail, ChatPeekFile } from '../../session/shared/extensions/app-runtime-protocol'
import { parseExtensionTabKind } from '../../session/shared/extensions/manifest'

/** The group's panel beside the messages: 520 wide at first, never under 360 (the slot's INLINE_COMMANDS), as wide as last dragged. */
export const GROUP_PANEL_WIDTHS: SidePanelWidths = { storageKey: 'gugu.groupPanel.width', min: 360, initial: 520 }

/** The preinstalled workspace App's tab (apps/desktop/preinstalled-apps/workspace): with no file, the chat's folder. */
export const WORKSPACE_APP_KIND = `${WORKSPACE_APP_ID}.main`

/**
 * One thing open in a chat's panel (owner 10-24: the panel has no floor under its tabs): an App's own page in this chat
 * — the chat's folder is one, the workspace App's — or a file of the chat, in the App that opens it; no App claims it:
 * the host's preview.
 */
export interface OpenedWith {
  message?: MessageItem
  /** Present only for a file opened from a message, whose caller owns the way back. */
  restore?: () => void
  /** No App claims it: the host's file preview. */
  kind: string | null
  file?: ChatPeekFile
  /** The file it shows; none for an App's own page (the folder is one). */
  itemId?: string
  title: string
  /** Original file name for downloads and tooltips; title is its display name. */
  fileName?: string
  /**
   * Its 「上一页」 (owner 10-24): the tab on screen when a page in the panel opened it — a file clicked in the folder, an
   * App's `files.openWith`. Opened straight from the chat (an App, a link, a pill) it has none.
   */
  from?: OpenedWith
  /** What kind of file it is (`typedFileName`): who opens it is decided by this. None without a file. */
  typedName?: string
  /** Its page's slot (`groupPageSlot`): the tab opened again keeps it, so the page is the one already there. */
  opening: number
}

/**
 * What a chat's panel is asked to open — every way in, one channel: an App (`app`: its own page, or the file it names in
 * the chat, `chatFile`), or a file of the chat and the place a pill points at (`opener`: `files.openWith`, whose host
 * already said who opens it, or among which the person picks; `fromPage`: a page in the panel asked).
 */
export type OpenAsk =
  | { app: string; tab?: string }
  | { itemId: string; at?: Record<string, string>; opener?: AppOpenWithDetail; message?: MessageItem; restore?: () => void; fromPage?: true }
/** What a chat hands its panel to open, once per ask (`request`), with the tab that was on screen when a page asked. */
export type OpenRequest = OpenAsk & { chatId: string; request: number; from?: OpenedWith }

let openings = 0
/** A new page's slot number (`OpenedWith.opening`). */
export const nextOpening = (): number => ++openings
/** The chat's folder, as a tab. */
export const folderTab = (): OpenedWith => ({ kind: WORKSPACE_APP_KIND, title: '', opening: nextOpening() })
export const isFolder = (item: OpenedWith | null): boolean => item?.kind === WORKSPACE_APP_KIND && !item.itemId

const appOf = (kind: string | null) => (kind === null ? null : parseExtensionTabKind(kind)?.extensionId ?? kind)
/**
 * One App's one resource is one tab, however it was opened (owner 10-24): the same file in the same App, through any of
 * its tabs; an App's own page (the folder, a group's member list) once a chat.
 */
export const sameTab = (a: OpenedWith, b: OpenedWith): boolean =>
  a.itemId || b.itemId ? a.itemId === b.itemId && appOf(a.kind) === appOf(b.kind) : a.kind === b.kind

/** The same slot identity for its page and every host drawing its title; none while what was asked is being found. */
export const groupPageSlot = (chatId: string, item: OpenedWith | null) => `group-app-slot:${chatId}${item ? `#${item.opening}` : ''}`
export interface OpenTopicTab { chatId: string; name: string; shown: boolean }
const remembered = new Map<string, { form: PanelForm; open: OpenedWith[]; active: OpenedWith | null; topic?: OpenTopicTab | null }>()
const listeners = new Set<() => void>()
const changed = () => { for (const listener of listeners) listener() }
const NO_TABS: readonly OpenedWith[] = []
const entryOf = (chatId: string) => remembered.get(chatId) ?? { form: 'closed' as PanelForm, open: [], active: null }
const asked = new Map<string, OpenAsk>()
/**
 * What a group's side panel has open, per group, for the life of the window (摩擦单 F29): its form (closed, beside the
 * messages, or full), the things open in it (gugu-dev#181 第 ⑥ 步: a block's tab strip lists each as a tab), in the
 * order they were opened, and which of them the panel shows. Nothing open, the panel is closed: it has no floor of its
 * own. Going elsewhere and coming back shows it as it was — the page itself is made again (F17 lets it go while unseen).
 * The panel draws the active one only; the chat page and the phone, which have no tab strip, show just that one.
 *
 * The right side shows one thing at a time (#1312): the panel, or the topic opened beside the group. The other one
 * stays open as a tab, not shown — so the panel's things are listed while the panel is closed, and `topic` is the
 * topic open beside the group, `shown` while its pane is up. Leaving an object through Back or × closes its tab.
 */
export const groupSlotMemory = {
  form: (chatId: string | null | undefined): PanelForm => (chatId ? remembered.get(chatId)?.form ?? 'closed' : 'closed'),
  setForm(chatId: string | null | undefined, form: PanelForm) {
    if (!chatId) return
    remembered.set(chatId, { ...entryOf(chatId), form })
    changed()
  },
  /** Something asked of this chat's panel (a link, a card, an App, a page's `files.openWith`): its panel takes it when it shows the chat. */
  ask(chatId: string, what: OpenAsk) {
    asked.set(chatId, what)
  },
  /** What was asked of this chat's panel, once: taken by the panel that opens it. */
  take(chatId: string | null | undefined): OpenAsk | null {
    if (!chatId) return null
    const what = asked.get(chatId) ?? null
    asked.delete(chatId)
    return what
  },
  /** What the panel shows: the active one. */
  opened: (chatId: string) => remembered.get(chatId)?.active ?? null,
  /**
   * The panel shows this now. Open already (`sameTab`), it is that tab — its page as it is; a page in the panel opening it
   * again becomes its 上一页. Else it joins the open ones, after the others.
   */
  open(chatId: string, item: OpenedWith) {
    const entry = entryOf(chatId)
    const there = entry.open.find((candidate) => sameTab(candidate, item))
    const shown = !there ? item : item.from && !sameTab(item.from, there) ? { ...there, from: item.from } : there
    remembered.set(chatId, { ...entry, open: there ? entry.open.map((candidate) => (candidate === there ? shown : candidate)) : [...entry.open, item], active: shown })
    changed()
  },
  /** The tabs, in the order they were opened; shown or not. */
  tabs: (chatId: string): readonly OpenedWith[] => remembered.get(chatId)?.open ?? NO_TABS,
  topic: (chatId: string): OpenTopicTab | null => remembered.get(chatId)?.topic ?? null,
  /** The topic pane beside the group now shows this one; `null`: it is down (the topic stays a tab until its ×). */
  showTopic(chatId: string | null | undefined, topic: { chatId: string; name: string } | null) {
    if (!chatId) return
    const entry = entryOf(chatId)
    const was = entry.topic ?? null
    const next = topic ? { chatId: topic.chatId, name: topic.name, shown: true } : was && { ...was, shown: false }
    if (was?.chatId === next?.chatId && was?.name === next?.name && was?.shown === next?.shown) return
    remembered.set(chatId, { ...entry, topic: next })
    changed()
  },
  /** A topic tab's ×: the topic leaves its group's tabs. */
  closeTopic(topicChatId: string) {
    for (const [chatId, entry] of remembered) {
      if (entry.topic?.chatId === topicChatId) remembered.set(chatId, { ...entry, topic: null })
    }
    changed()
  },
  /** A tab clicked: the panel shows it. */
  activate(chatId: string, item: OpenedWith) {
    const entry = entryOf(chatId)
    const found = entry.open.find((candidate) => sameTab(candidate, item))
    if (!found) return
    remembered.set(chatId, { ...entry, active: found })
    changed()
  },
  /** Back and × leave a tab: shown, the panel goes back to its 上一页 if that is still open, else its neighbour; the last closes the panel. */
  close(chatId: string, item: OpenedWith | null, onClosePanel?: () => void) {
    if (!item) return
    const entry = entryOf(chatId)
    const at = entry.open.findIndex((candidate) => sameTab(candidate, item))
    if (at < 0) return
    const leaving = entry.open[at]!
    const rest = entry.open.filter((_, index) => index !== at)
    const back = leaving.from ? rest.find((candidate) => sameTab(candidate, leaving.from!)) : undefined
    const active = entry.active && sameTab(entry.active, leaving) ? (back ?? rest[at] ?? rest[at - 1] ?? null) : entry.active
    remembered.set(chatId, rest.length > 0 ? { ...entry, open: rest, active } : { ...entry, form: 'closed', open: [], active: null })
    extensionSurfaceStore.forget(null, groupPageSlot(chatId, leaving))
    changed()
    if (leaving.restore || rest.length === 0) onClosePanel?.()
    leaving.restore?.()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
