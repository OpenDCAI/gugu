import type { ReactNode } from 'react'

/** Where `query` is in `text`, marked as the chat's search marks it — in a message, and in a picker's names. */
export function highlightText(text: string, query: string): ReactNode {
  if (!query.trim()) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} style={{ background: 'var(--color-warning-highlight)', borderRadius: '2px', padding: '0 1px', color: 'inherit' }}>
        {part}
      </mark>
    ) : (
      part
    ),
  )
}
