import { textFilePatch } from '../../lib/text-diff';
import type { EntityContent } from '../models/entity-content';

/** Standard v2 blocks keep every field and byte; v1 is converted once, here. */
export function normalizeToolContent(content: readonly EntityContent[] | null | undefined, toolKind?: string | null): EntityContent[] | null | undefined {
  if (content == null) return content;
  return content.map(block => {
    if (block.type !== 'diff') return block;
    if (Array.isArray(block.changes)) return { ...block, scope: block.scope ?? 'file' };
    if (typeof block.path !== 'string' || typeof block.newText !== 'string') throw new Error('Invalid text replacement diff');
    const { path, oldText, newText, ...fields } = block;
    if (toolKind === 'delete' && typeof oldText !== 'string') return { ...fields, changes: [{ operation: 'delete', path }], scope: 'unknown', patch: null };
    return { ...fields, ...textFilePatch(path, typeof oldText === 'string' ? oldText : null, toolKind === 'delete' ? null : newText) };
  });
}
