import type { Nodes } from 'mdast';
import { parseMarkdown } from '@gugu/session-shared/markdown/dialect';

function inlineText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'break') return ' ';
  return 'children' in node ? node.children.map(inlineText).join('') : '';
}

/** Preview the first body facts, never the agent's frontmatter/index instructions. */
export function memoryContentPreview(body: string, limit = 320): string {
  const facts: string[] = [];
  const collect = (node: Nodes) => {
    if (facts.length >= 4) return;
    if (['heading', 'code', 'html', 'definition', 'footnoteDefinition'].includes(node.type)) return;
    if (node.type === 'paragraph' || node.type === 'tableRow') {
      const text = (node.type === 'tableRow' ? node.children.map(inlineText).join(' · ') : inlineText(node)).replace(/\s+/g, ' ').trim();
      if (text) facts.push(text);
    } else if ('children' in node) node.children.forEach(collect);
  };
  collect(parseMarkdown(body));
  const text = facts.join(' ');
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('').trimEnd()}…` : text;
}
