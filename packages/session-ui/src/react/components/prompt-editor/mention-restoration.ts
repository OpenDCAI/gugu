import type { Node } from '@tiptap/pm/model';
import { serializeNode } from './serialize';
import type { PromptEditorRef } from './types';

/** Map serialized offsets to text only; existing atoms must retain their identity. */
export function mentionRestorationRanges(doc: Node, references: Parameters<PromptEditorRef['restoreMentions']>[0]) {
  const ranges: Array<{ from: number; to: number; item: (typeof references)[number]['item'] }> = [];
  let at = 0;
  doc.forEach((block, blockPosition) => {
    block.forEach((node, childPosition) => {
      const end = at + serializeNode(node).length;
      if (node.isText) {
        for (const ref of references) {
          if (ref.start >= at && ref.end <= end && ref.end > ref.start) {
            ranges.push({ from: blockPosition + 1 + childPosition + ref.start - at,
              to: blockPosition + 1 + childPosition + ref.end - at, item: ref.item });
          }
        }
      }
      at = end;
    });
    at += 1; // Serialized paragraph boundary.
  });
  return ranges.sort((a, b) => b.from - a.from);
}
