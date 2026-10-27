const INLINE_CODE = /(`[^`\n]+`)/

/**
 * Markdown as one line of plain text, for previews (chat list rows and the notifications built from them).
 * Inline code stays exactly as written: it is literal text, and a reference inside it is not a reference.
 * Previews arrive cut at a length limit, so a marker can lose its partner (`**10/27 全天复盘** **凌晨…`);
 * leftover markers outside code are dropped too, not just matched pairs.
 */
export function markdownPlainText(text: string): string {
  return text
    .replace(/`{3}[\s\S]*?`{3}/g, '')
    .split(INLINE_CODE)
    .map((part, index) => (index % 2 === 1 ? part : plainSegment(part)))
    .join('')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
}

function plainSegment(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(?<![\w*])(\*|_)(?=\S)([^*_\n]*?\S)\1(?![\w*])/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/\*\*|__|~~/g, '')
}
