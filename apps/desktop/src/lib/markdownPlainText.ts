/**
 * Markdown as one line of plain text, for previews (chat list rows, notifications, issue summaries).
 * Previews arrive cut at a length limit, so a marker can lose its partner (`**10/27 全天复盘** **凌晨…`);
 * leftover markers are dropped too, not just matched pairs.
 */
export function markdownPlainText(text: string): string {
  return text
    .replace(/`{3}[\s\S]*?`{3}/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(?<![\w*])(\*|_)(?=\S)([^*_\n]*?\S)\1(?![\w*])/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/\*\*|__|~~|`+/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
}
