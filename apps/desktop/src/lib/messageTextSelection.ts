export const MESSAGE_SELECTION_SETTLED = 'gugu:message-selection-settled'

export interface MessageTextSelection {
  text: string
  selectionId: string
}

export interface MessageTextSelectionOptions {
  enabled: boolean
  onQuote: (text: string, selectionId: string) => void
  onClearQuote: (selectionId: string) => void
  onContext: (selection: MessageTextSelection | null) => void
}

let sequence = 0
const scopes = new WeakMap<Document, Set<HTMLElement>>()

/** A text root and callbacks are the only renderer contract. React and transcript renderers can share it. */
export function observeMessageTextSelection(root: HTMLElement, options: MessageTextSelectionOptions): () => void {
  if (!options.enabled) return () => {}
  const doc = root.ownerDocument
  const roots = scopes.get(doc) ?? new Set<HTMLElement>()
  roots.add(root)
  scopes.set(doc, roots)
  let context: MessageTextSelection | null = null
  let quoted: string | null = null
  let lastQuoted: string | null = null
  let gesture = 0
  let signature = ''
  let touching = false

  const publish = (next: MessageTextSelection | null) => {
    if (context?.selectionId === next?.selectionId) return
    context = next
    options.onContext(next)
  }
  const read = () => {
    const selection = doc.getSelection()
    if (!selection || selection.isCollapsed) {
      publish(null)
      return null
    }
    const anchorInside = root.contains(selection.anchorNode)
    const focusInside = root.contains(selection.focusNode)
    if (!anchorInside || !focusInside) {
      publish(null)
      if (quoted) {
        const anchorRoot = [...roots].find(scope => scope.contains(selection.anchorNode))
        const focusRoot = [...roots].find(scope => scope.contains(selection.focusNode))
        const crossed = anchorInside !== focusInside || (anchorRoot && focusRoot && anchorRoot !== focusRoot)
        if (crossed) { options.onClearQuote(quoted); quoted = null }
      }
      return null
    }
    const text = selection.toString()
    if (!text.trim()) { publish(null); return null }
    const nextSignature = `${gesture}:${selection.anchorOffset}:${selection.focusOffset}:${text}`
    if (signature !== nextSignature || !context) {
      signature = nextSignature
      publish({ text, selectionId: `message-selection-${++sequence}` })
    }
    return context
  }
  const commit = () => {
    const next = read()
    if (!next || next.selectionId === lastQuoted) return
    lastQuoted = next.selectionId
    quoted = next.selectionId
    options.onQuote(next.text, next.selectionId)
  }
  const down = (event: Event) => {
    if (!root.contains(event.target as Node) || ('pointerType' in event && event.pointerType !== 'touch')) return
    if (!touching) gesture++
    touching = true
  }
  const up = () => { touching = false; commit() }
  const cancelled = () => { touching = false }
  const settled = () => { touching = false; commit() }
  const listeners: [string, EventListener][] = [
    ['selectionchange', read], ['pointerdown', down], ['touchstart', down],
    ['pointerup', up], ['touchend', up], ['pointercancel', cancelled], ['touchcancel', cancelled],
    [MESSAGE_SELECTION_SETTLED, settled],
  ]
  for (const [type, listener] of listeners) doc.addEventListener(type, listener, true)
  return () => {
    for (const [type, listener] of listeners) doc.removeEventListener(type, listener, true)
    roots.delete(root)
    publish(null)
  }
}
