import { groupFileLink, parseGroupFileLink } from '@gugu/core/shared/ui/guguLink'
import { stringifyMention } from '@gugu/session-shared/markdown'
import type { Element, ElementContent, Root } from 'hast'

/**
 * App 引用 pill (owner 10-14): `@[label](gugu-file://<id>?v=…#<at>)` — the session page's @file mention, pointing at a
 * group's file — drawn in a chat bubble as the same pill the transcript draws. Marked after sanitizing (`afterSanitize`,
 * dialect.ts): the `@` before a group file's link goes, the link carries `gg-file-pill`, and `Markdown`'s link draws it.
 * The link itself is untouched: a click opens it as any group file link opens (`chatLinks` → `classifyFileLink`).
 */
export const FILE_PILL_CLASS = 'gg-file-pill'

export function rehypeGroupFilePills() {
  return (tree: Root) => mark(tree)
}

function mark(parent: Root | Element): void {
  const children = parent.children as ElementContent[]
  children.forEach((node, index) => {
    if (node.type !== 'element') return
    const href = node.properties?.href
    const before = children[index - 1]
    if (node.tagName === 'a' && typeof href === 'string' && parseGroupFileLink(href) && before?.type === 'text' && before.value.endsWith('@')) {
      before.value = before.value.slice(0, -1)
      const classes = Array.isArray(node.properties.className) ? node.properties.className : []
      node.properties.className = [...classes, FILE_PILL_CLASS]
      return
    }
    mark(node)
  })
}

/**
 * A pill as its message holds it: copied out of a bubble, it pastes back as a pill (and reads as one anywhere else). A
 * bubble's href is percent-encoded by the renderer: read, then written again the one way gugu writes the link.
 */
export function filePillToken(label: string, href: string): string {
  const link = parseGroupFileLink(href)
  return filePillText({ label, link: link ? groupFileLink(link.itemId, link) : href })
}

/** A compose's file reference: its words and its group file link. */
export interface FilePill {
  label: string
  link: string
}

/** The pill as a message's text holds it — `stringifyMention`'s @file form, the one the bubble and the transcript draw. */
export function filePillText(pill: FilePill): string {
  return stringifyMention({ label: pill.label, target: pill.link, kind: 'file' })
}

let copyHooked = false
/**
 * Once per window: a copy whose selection holds pills puts each as its text (`filePillToken`), not only its label —
 * the rest of the selection as the browser would put it.
 */
export function hookFilePillCopy(): void {
  if (copyHooked || typeof document === 'undefined') return
  copyHooked = true
  document.addEventListener('copy', (event) => {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
    const copied = selection.getRangeAt(0).cloneContents()
    const pills = copied.querySelectorAll<HTMLAnchorElement>(`a.${FILE_PILL_CLASS}`)
    if (pills.length === 0 || !event.clipboardData) return
    for (const pill of pills) pill.replaceWith(document.createTextNode(filePillToken(pill.textContent ?? '', pill.getAttribute('href') ?? '')))
    event.clipboardData.setData('text/plain', copied.textContent ?? '')
    event.preventDefault()
  })
}
