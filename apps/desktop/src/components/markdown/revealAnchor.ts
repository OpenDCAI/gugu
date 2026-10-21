import { MARKDOWN_SANITIZE_SCHEMA } from '@gugu/session-shared/markdown/dialect'

/**
 * Scroll a rendered document to the element a fragment names: a footnote, or a heading (#6950). The sanitizer prefixes
 * every id (`clobberPrefix`) while a link keeps the fragment as written — maybe percent-encoded (`#%E4%B8%AD…` for
 * `#中文-标题`) or in another case — so the lookup decodes and also tries the slug's lower case. A heading comes to the
 * top, as a jump to a section should; a footnote only into view (`nearest`). False when nothing is found.
 */
export function revealMarkdownAnchor(root: Element | null, fragment: string): boolean {
  if (!root || !fragment) return false
  let decoded = fragment
  try {
    decoded = decodeURIComponent(fragment)
  } catch {
    // a malformed escape: look the fragment up as written
  }
  const prefix = MARKDOWN_SANITIZE_SCHEMA.clobberPrefix
  const target = [decoded, decoded.toLowerCase()]
    .map((name) => root.querySelector(`[id="${CSS.escape(`${prefix}${name}`)}"]`))
    .find((element) => element !== null)
  if (!target) return false
  target.scrollIntoView({ block: /^H[1-6]$/.test(target.tagName) ? 'start' : 'nearest' })
  return true
}
