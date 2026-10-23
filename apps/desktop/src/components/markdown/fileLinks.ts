import type { MessageItem } from '@gugu/core/shared/types/chat'
import { classifyFileLink, parseGroupFileLink } from '@gugu/core/shared/ui/fileLink'
import { GROUP_FILE_OPEN_EVENT, type GroupFileOpenDetail } from '../../session/shared/extensions/app-runtime-protocol'
import { openAppLink } from '../../lib/inAppLinks'

let opening = 0

/**
 * A file of a source group or private chat, opened where the person is (摩擦单 F10): the chat it is in is read from the file (F112 — the
 * person sees only the files of chats they are in), then the chat shell brings that chat up and takes it. False when it
 * could not (the person is not in that chat, or the file is gone; they were told so). `at`: the place in it a pill points
 * at (its link's `#…`), handed to the App that opens the file as a `link` event.
 */
export async function openGroupFile(itemId: string, at?: Record<string, string>, message?: MessageItem, restore?: () => void): Promise<boolean> {
  // The file asked last is the one opened (#7257): two links clicked one after the other, their chats read in either
  // order — the earlier click's answer coming back later is dropped (true: nothing to tell the person).
  const asked = ++opening
  // Loaded when a link opens, not with this module: the session page's modules import this, and the chat client is made
  // (from the signed-in session's settings) when its module loads.
  const { chatDb } = await import('../../lib/supabase')
  const { data, error } = await chatDb.from('workspace_items').select('chat_id').eq('id', itemId).maybeSingle()
  if (asked !== opening) return true
  if (error) throw new Error(`the file's chat could not be read: ${error.message}`)
  const detail: GroupFileOpenDetail = { chatId: (data?.chat_id as string | undefined) ?? null, itemId, ...(at ? { at } : {}), ...(message ? { message } : {}), ...(restore ? { restore } : {}) }
  return !window.dispatchEvent(new CustomEvent(GROUP_FILE_OPEN_EVENT, { detail, cancelable: true }))
}

/**
 * A url asked to open in a tab (`session_open_in_tab`, here or on a machine): a group's file is opened in its group.
 * Null when it is no group file link; else whether it was opened.
 */
export function openGroupFileLink(url: string): Promise<boolean> | null {
  const link = parseGroupFileLink(url)
  return link ? openGroupFile(link.itemId, link.at) : null
}

/**
 * Chat link policy: a link to a group's file (`gugu-file://…`, 摩擦单 F10) opens it in that group's panel, whoever wrote
 * it (an App's whisper is written as the person); a workspace-file link opens the file in the app when `openLocalFile`
 * is given (an agent's message); a link the app itself opens (inAppLinks.ts — a machine's `gugu-server login` link on the
 * phone) opens there; any other link goes to the system browser.
 */
export function chatLinks(openLocalFile: ((path: string) => void) | undefined): (href: string) => boolean {
  return (href) => {
    if (openAppLink(href)) return true
    const link = classifyFileLink(href)
    if (link.kind === 'group-file') {
      void openGroupFile(link.itemId, link.at)
      return true
    }
    if (link.kind !== 'workspace-file' || !openLocalFile) return false
    openLocalFile(link.path)
    return true
  }
}
