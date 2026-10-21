/**
 * parse — markdown string to the transcript's Block[].
 *
 * The grammar, source normalization and sanitizing are the shared dialect's
 * (@gugu/session-shared/markdown/dialect) — the same ones every React markdown
 * surface uses. The transcript adds one remark transform of its own:
 * `remarkInlineMentions` folds `@[label](target)` links and splits `@bare` /
 * `/command` text into mention nodes (per-call providers travel on the VFile so
 * the processor is built once). `treeToBlocks` then turns the tree into blocks.
 *
 * Identity-stable caching of parsed Block arrays lives in the per-instance
 * `ChatCaches.parseBlocks` bundle (core/caches.ts), not here.
 *
 * This module is PURE: no geometry, no pretext/fonts, no DOM imports.
 */

import { createMarkdownParser, normalizeMarkdownSource } from '@gugu/session-shared/markdown/dialect';
import type { Root } from 'mdast';
import { VFile } from 'vfile';
import type { CommandProvider } from './command-provider';
import type { Block } from './document';
import type { MentionProvider } from './mention-provider';
import { remarkInlineMentions } from './remark-inline-mentions';
import type { ParseData } from './remark-inline-mentions';
import { TRANSCRIPT_DIALECT, treeToBlocks } from './to-html';

const processor = createMarkdownParser(TRANSCRIPT_DIALECT, [remarkInlineMentions]);

/**
 * Parse a markdown string into a stable `Block[]` that both the measurement
 * engine and block renderer components consume.
 *
 * Block IDs are in the form `${messageId}#${index}` where `index` is the
 * position in the flat block list produced by the parse. IDs are stable as
 * long as the full text is re-parsed (not incrementally mutated).
 *
 * @param messageId       - Stable item id used as the block-id prefix.
 * @param markdown        - Raw markdown string to parse.
 * @param mentionProvider - Optional @-mention resolver.
 * @param commandProvider - Optional /-command resolver.
 * @param startN          - Starting block counter (default 0). Used by the incremental
 *                          streaming parser so tail chunks continue the stable prefix's ids.
 * @param uri             - Conversation URI forwarded to provider `.resolve()`.
 */
export function parseMarkdownToBlocks(
  messageId: string,
  markdown: string,
  mentionProvider?: MentionProvider,
  commandProvider?: CommandProvider,
  startN = 0,
  uri?: string
): Block[] {
  if (!markdown.trim()) return [];
  const data: ParseData = { messageId, startN, uri, mentionProvider, commandProvider };
  const file = new VFile({ value: normalizeMarkdownSource(markdown), data: data as unknown as Record<string, unknown> });
  const tree = processor.runSync(processor.parse(file), file) as Root;
  const counter = { n: startN };
  return treeToBlocks(tree, () => `${messageId}#${counter.n++}`);
}

const flattened = new WeakMap<Block, Block>();

/**
 * Headings read as body text — for rows where an agent's section headers would
 * shout (reasoning). Identity-stable per input block, so measurement memos hit.
 */
export function flattenBlockHeadings(blocks: Block[]): Block[] {
  return blocks.map((block) => {
    if (block.kind !== 'html') return block;
    let flat = flattened.get(block);
    if (!flat) {
      flat = { ...block, flat: true };
      flattened.set(block, flat);
    }
    return flat;
  });
}
