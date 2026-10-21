/**
 * Serialize a TipTap/ProseMirror document to plain text.
 *
 * Rules:
 *  - `mention` node   → `@[name](target)` for file mentions (angle-bracket
 *     dest for paths with spaces); `@label` for other kinds.
 *  - `slashCommand` node → its `token` attr verbatim (the host computed it;
 *     `/name` fallback only for nodes that carry no token)
 *  - `hardBreak` node → `\n`
 *  - paragraph boundary → `\n` between paragraphs (but NOT trailing)
 *  - all other inline nodes / marks → plain text content
 */

import { stringifyMention } from '@gugu/session-shared/markdown';
import { fallbackToken } from './command-token';
import type { MentionKind } from '@gugu/session-shared/markdown';
import type { Node } from '@tiptap/pm/model';

/**
 * Serialize a mention to its canonical text form.
 *
 * Delegates to the shared `stringifyMention` so the composer's output grammar
 * and the transcript parser's input grammar cannot drift from each other.
 *
 * @param label - The full path / id stored in the `label` attr (= the target).
 * @param kind  - Mention kind ('file' | 'issue' | 'symbol' | 'custom' | null).
 * @param name  - Short display name (basename); used as the bracket label.
 */
export function serializeMentionLabel(
  label: string,
  kind: string | null,
  name?: string | null
): string {
  return stringifyMention({
    label: name ?? label,
    target: label,
    kind: kind as MentionKind | null,
  });
}

/**
 * Serialize a single ProseMirror node to its plain-text representation.
 * Exported so that `clipboardTextSerializer` (and other callers) can reuse it
 * without going through `serializeDoc`, which expects a full document root.
 */
export function serializeNode(node: Node): string {
  if (node.type.name === 'mention') {
    const label = (node.attrs.label as string | null) ?? (node.attrs.id as string | null) ?? '';
    const name = node.attrs.name as string | null;
    return serializeMentionLabel(label, node.attrs.kind as string | null, name);
  }

  if (node.type.name === 'slashCommand') {
    const token = node.attrs.token as string | null;
    if (token) return token;
    return fallbackToken((node.attrs.name as string | null) ?? (node.attrs.id as string | null) ?? '');
  }

  if (node.type.name === 'hardBreak') {
    return '\n';
  }

  if (node.isText) {
    return node.text ?? '';
  }

  // Recurse into block/inline containers
  const parts: string[] = [];
  node.forEach((child) => {
    parts.push(serializeNode(child));
  });
  return parts.join('');
}

/**
 * Serialize the whole editor document to a plain-text string.
 * Paragraphs are joined by a single newline; trailing newline is trimmed.
 */
export function serializeDoc(doc: Node): string {
  const paragraphs: string[] = [];

  doc.forEach((block) => {
    const parts: string[] = [];
    block.forEach((child) => {
      parts.push(serializeNode(child));
    });
    paragraphs.push(parts.join(''));
  });

  // Join paragraphs with newlines, collapse trailing blank lines
  return paragraphs.join('\n').replace(/\n+$/, '');
}

/**
 * The inverse of {@link serializeDoc} for plain text: one paragraph per line.
 *
 * Shared with the prompt-history keymap so recalling a past prompt rebuilds exactly the document
 * `setText` would have produced — a recalled prompt and a typed one must be the same thing.
 */
export function plainTextDoc(text: string) {
  const lines = text.length > 0 ? text.split(/\r?\n/) : [''];
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      ...(line.length > 0 ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}
