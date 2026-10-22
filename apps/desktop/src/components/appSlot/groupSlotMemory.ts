import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { PanelForm, SidePanelWidths } from '../../session/renderer/lib/layout/side-panel-split'
import type { AppOpenWithDetail, ChatPeekFile } from '../../session/shared/extensions/app-runtime-protocol'

/** The group's panel beside the messages: 520 wide at first, never under 360 (the slot's INLINE_COMMANDS), as wide as last dragged. */
export const GROUP_PANEL_WIDTHS: SidePanelWidths = { storageKey: 'gugu.groupPanel.width', min: 360, initial: 520 }

/**
 * What the panel shows instead of the workspace: a file of the group opened with an App (「用 X 打开」) — that App, handed
 * that file — or, with no file, an App's own page opened in this group (「在本群打开」).
 */
export interface OpenedWith {
  message?: MessageItem
  /** No App claims it: the host's file preview. */
  kind: string | null
  file?: ChatPeekFile
  /** The file it was handed; none for an App's own page. */
  itemId?: string
  title: string
  /** What kind of file it is (`typedFileName`): who opens it is decided by this. None without a file. */
  typedName?: string
  /** Counts the opens: each is a page of its own, never one left from before (摩擦单 F28). */
  opening: number
}

/**
 * A file of a group asked to be opened, and the place in it a pill points at (its link's `#…`); `opener`: asked by
 * `files.openWith`, whose host already said who opens it (or among which the person picks).
 */
export interface AskedFile {
  message?: MessageItem
  itemId: string
  at?: Record<string, string>
  opener?: AppOpenWithDetail
}
/** What a chat's or a topic's pane hands its panel to open: the asked file, in that chat, once per ask (`request`). */
export interface FileToOpen extends AskedFile {
  chatId: string
  request: number
}

/**
 * What a group's side panel has open, per group, for the life of the window (摩擦单 F29): its form (closed, beside the
 * messages, or full), the things open in it (gugu-dev#181 第 ⑥ 步: a block's tab strip lists each as a tab — the
 * folder, an App's page, a file in an App), in the order they were opened, and which of them the panel shows. `null`
 * is the folder. Going elsewhere and coming back shows it as it was — the page itself is made again (F17 lets it go
 * while unseen). The panel draws the active one only; the chat page and the phone, which have no tab strip, look the
 * same as when the panel kept one thing.
 *
 * The right side shows one thing at a time (#1312): the panel, or the topic opened beside the group. The other one
 * stays open as a tab, not shown — so the panel's things are listed while the panel is closed, and `topic` is the
 * topic open beside the group, `shown` while its pane is up. Only a tab's × closes it.
 */
type PanelItem = OpenedWith | null
export interface OpenTopicTab { chatId: string; name: string; shown: boolean }
const remembered = new Map<string, { form: PanelForm; open: PanelItem[]; active: PanelItem; topic?: OpenTopicTab | null }>()
/** The same thing opened again (the same App's page, the same file in the same App) is the same tab. */
const sameItem = (a: PanelItem, b: PanelItem) => (a === null || b === null ? a === b : a.kind === b.kind && a.itemId === b.itemId)
const listeners = new Set<() => void>()
const changed = () => { for (const listener of listeners) listener() }
const NO_TABS: readonly PanelItem[] = []
const FOLDER_ONLY: readonly PanelItem[] = [null]
const entryOf = (chatId: string) => remembered.get(chatId) ?? { form: 'closed' as PanelForm, open: [], active: null }
const asked = new Map<string, AskedFile>()
const askedApps = new Map<string, string>()
export const groupSlotMemory = {
  form: (chatId: string | null | undefined): PanelForm => (chatId ? remembered.get(chatId)?.form ?? 'closed' : 'closed'),
  setForm(chatId: string | null | undefined, form: PanelForm) {
    if (!chatId) return
    remembered.set(chatId, { ...entryOf(chatId), form })
    changed()
  },
  /** A file of this group asked to be opened (a link, 摩擦单 F10): its panel opens it when it next shows the group. */
  askFile(chatId: string, itemId: string, at?: Record<string, string>, opener?: AppOpenWithDetail, message?: MessageItem) {
    asked.set(chatId, { itemId, ...(at ? { at } : {}), ...(opener ? { opener } : {}), ...(message ? { message } : {}) })
    const entry = entryOf(chatId)
    remembered.set(chatId, { ...entry, form: entry.form === 'closed' ? 'side' : entry.form })
    changed()
  },
  /** The file asked for this group, once: taken by the panel that opens it. */
  takeFile(chatId: string | null | undefined): AskedFile | null {
    if (!chatId) return null
    const file = asked.get(chatId) ?? null
    asked.delete(chatId)
    return file
  },
  /** An App asked to open in this chat's panel (a banner's or a link's click names the chat): taken by the panel. */
  askApp(chatId: string, extensionId: string) {
    askedApps.set(chatId, extensionId)
  },
  takeApp(chatId: string | null | undefined): string | null {
    if (!chatId) return null
    const extensionId = askedApps.get(chatId) ?? null
    askedApps.delete(chatId)
    return extensionId
  },
  /** The panel came up: what it shows is open — the folder too, when nothing else was — a tab until its ×. */
  noteShown(chatId: string) {
    const entry = entryOf(chatId)
    if (entry.open.length > 0) return
    remembered.set(chatId, { ...entry, open: [entry.active] })
    changed()
  },
  /** What the panel shows: the active one (`null` = the folder). */
  opened: (chatId: string) => remembered.get(chatId)?.active ?? null,
  /**
   * The panel shows this now: opened before, it is that tab again (the newer opening, so the page is made anew); else
   * it joins the open ones, after what was showing (which stays open as a tab).
   */
  setOpened(chatId: string, opened: OpenedWith | null) {
    const entry = remembered.get(chatId)
    const shown = entry ? entry.active : null
    let open = entry ? [...entry.open] : []
    if (!open.some((item) => sameItem(item, shown))) open.push(shown)
    open = open.some((item) => sameItem(item, opened)) ? open.map((item) => (sameItem(item, opened) ? opened : item)) : [...open, opened]
    remembered.set(chatId, { ...entry, form: entry?.form ?? 'side', open, active: opened })
    changed()
  },
  /** The tabs, in the order they were opened; shown or not. Nothing opened yet = the folder alone while the panel is up. */
  tabs(chatId: string): readonly PanelItem[] {
    const entry = remembered.get(chatId)
    if (!entry) return NO_TABS
    return entry.open.length > 0 ? entry.open : entry.form === 'closed' ? NO_TABS : FOLDER_ONLY
  },
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
  /** A tab clicked, or the folder picked from the strip's「+」: the panel shows it (the folder joins the tabs if it was closed). */
  activate(chatId: string, item: PanelItem) {
    const entry = entryOf(chatId)
    const open = entry.open.length > 0 ? [...entry.open] : [null]
    let found = open.find((candidate) => sameItem(candidate, item))
    if (found === undefined) {
      if (item !== null) return
      open.push(null)
      found = null
    }
    remembered.set(chatId, { ...entry, open, active: found, form: entry.form === 'closed' ? 'side' : entry.form })
    changed()
  },
  /** A tab's ×: it leaves the open ones; the one shown goes to its neighbour; the last one closes the panel. */
  close(chatId: string, item: PanelItem) {
    const entry = entryOf(chatId)
    const open = entry.open.length > 0 ? entry.open : [null]
    const at = open.findIndex((candidate) => sameItem(candidate, item))
    if (at < 0) return
    const rest = open.filter((_, index) => index !== at)
    const active = sameItem(entry.active, item) ? (rest[at] ?? rest[at - 1] ?? null) : entry.active
    remembered.set(chatId, rest.length > 0 ? { ...entry, open: rest, active } : { ...entry, form: 'closed', open: [], active: null })
    changed()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
