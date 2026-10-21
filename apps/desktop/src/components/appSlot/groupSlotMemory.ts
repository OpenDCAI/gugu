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
 * What a group's side panel showed, per group, for the life of the window (摩擦单 F29): its form (closed, beside the
 * messages, or full), and which App on which file. Going elsewhere (another group, New Agent, the session page) and coming
 * back shows it as it was — the page itself is made again (F17 lets it go while unseen).
 */
const remembered = new Map<string, { form: PanelForm; opened: OpenedWith | null }>()
const asked = new Map<string, AskedFile>()
const askedApps = new Map<string, string>()
export const groupSlotMemory = {
  form: (chatId: string | null | undefined): PanelForm => (chatId ? remembered.get(chatId)?.form ?? 'closed' : 'closed'),
  setForm(chatId: string | null | undefined, form: PanelForm) {
    if (!chatId) return
    remembered.set(chatId, { opened: remembered.get(chatId)?.opened ?? null, form })
  },
  /** A file of this group asked to be opened (a link, 摩擦单 F10): its panel opens it when it next shows the group. */
  askFile(chatId: string, itemId: string, at?: Record<string, string>, opener?: AppOpenWithDetail, message?: MessageItem) {
    asked.set(chatId, { itemId, ...(at ? { at } : {}), ...(opener ? { opener } : {}), ...(message ? { message } : {}) })
    const form = groupSlotMemory.form(chatId)
    remembered.set(chatId, { opened: remembered.get(chatId)?.opened ?? null, form: form === 'closed' ? 'side' : form })
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
  opened: (chatId: string) => remembered.get(chatId)?.opened ?? null,
  setOpened(chatId: string, opened: OpenedWith | null) {
    remembered.set(chatId, { form: remembered.get(chatId)?.form ?? 'side', opened })
  },
}
