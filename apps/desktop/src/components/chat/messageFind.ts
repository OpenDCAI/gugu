import { locateFindRange, paintFindHighlight } from '@gugu/session-chat-ui/find-highlight'
import { documentToPlainText } from '@gugu/session-chat-ui/markdown-html'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { parseVoiceAttachmentContent } from '@gugu/core/shared/ui/voiceAttachmentModels'
import { parseComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { FindBackend } from '@renderer/lib/ui/use-find-bar'
import type { FlowListHandle } from '@/lib/flowList'
import { resolveSourceMessageScroll, type ScrollableRow } from '@/lib/sourceMessageScroll'
import { parseQuotedContent, partialQuotedContent } from './messageQuoteContent'

type Match = { id: string; start: number; text: string }
const EMPTY = { currentIndex: 0, total: 0 }

/** Search the already-loaded model; DOM is used only to paint the selected occurrence. */
export function createMessageFind(deps: {
  messages: readonly MessageItem[]
  rows: readonly ScrollableRow[]
  root: () => HTMLElement | null
  list: () => FlowListHandle | null
  scroller: () => HTMLElement | null
}): FindBackend {
  const owner = {}
  let query = '', current = -1, frame = 0
  let matches: Match[] = []
  let observer: MutationObserver | null = null
  let paintedDocument: Document | null = null
  const status = () => ({ currentIndex: current + 1, total: matches.length })
  const paint = (range: Range | null) => {
    const document = range?.startContainer.ownerDocument ?? paintedDocument
    if (document) paintFindHighlight(document, owner, range)
    paintedDocument = range ? document : null
  }
  const cancel = () => { cancelAnimationFrame(frame); frame = 0; observer?.disconnect(); observer = null; paint(null) }
  const rangeOf = (match: Match) => {
    const row = deps.root()?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(match.id)}"] [data-message-find-content]`)
    return row ? locateFindRange(row, query, match.text.slice(0, match.start).match(/\S/gu)?.length ?? 0) : null
  }
  const reveal = () => {
    cancel()
    const match = matches[current], root = deps.root()
    if (!match || !root) return
    const index = resolveSourceMessageScroll(deps.rows, match.id)
    if (index === null) return
    // The local FlowList branch never calls loadMessageAnchor or either history loader.
    deps.list()?.scrollToIndex({ index, align: 'center', behavior: 'auto' })
    let remaining = 90
    const mount = () => {
      frame = 0
      const range = rangeOf(match)
      if (!range) { if (--remaining > 0) frame = requestAnimationFrame(mount); return }
      const scroller = deps.scroller()
      if (scroller) {
        const hit = range.getBoundingClientRect(), box = scroller.getBoundingClientRect()
        scroller.scrollTop += hit.top + hit.height / 2 - (box.top + box.height / 2)
      }
      paint(range)
      observer = new MutationObserver(() => paint(rangeOf(match)))
      observer.observe(root, { childList: true, subtree: true, characterData: true })
    }
    frame = requestAnimationFrame(mount)
  }
  return {
    find(next) {
      query = next; matches = []; current = -1
      if (!query) { cancel(); return EMPTY }
      const needle = query.toLowerCase()
      for (const message of deps.messages) {
        if (message.retracted_at || resolveSourceMessageScroll(deps.rows, message.id) === null) continue
        const attachment = message.content_type === 'attachment'
          ? parseVoiceAttachmentContent(message.content) ?? parseAttachmentContent(message.content, message) : null
        const card = message.content_type === 'card' ? parseComposerCard(message.content) : null
        const partial = partialQuotedContent(message)
        const quoted = !partial ? parseQuotedContent(message.content ?? '') : null
        const body = partial?.replyText ?? (quoted ? `${quoted.replyText}\n${quoted.quoteText}` : message.content ?? '')
        const text = attachment
          ? [attachment.fileName, 'transcript' in attachment ? attachment.transcript : attachment.caption].filter(Boolean).join('\n')
          : card ? [documentToPlainText(card.text), ...(card.type === 'task' ? card.files?.map(file => file.name) ?? [] : [])].join('\n')
          : message.content_type === 'attachment' || message.content_type === 'widget' ? '' : documentToPlainText(body)
        const hay = text.toLowerCase()
        for (let start = hay.indexOf(needle); start !== -1; start = hay.indexOf(needle, start + needle.length)) matches.push({ id: message.id, start, text })
      }
      current = matches.length ? 0 : -1
      reveal()
      return status()
    },
    step(direction) {
      if (matches.length) current = (current + (direction === 'next' ? 1 : -1) + matches.length) % matches.length
      reveal()
      return status()
    },
    clear() { query = ''; matches = []; current = -1; cancel() },
  }
}
