import { z } from 'zod';

/** Content blocks retain fields that a particular view does not render. */
export const entityContentSchema = z.object({ type: z.string() }).passthrough();
export type EntityContent = z.infer<typeof entityContentSchema>;
export type EntityMeta = Record<string, unknown>;

/** Metadata patches replace top-level values; they never merge nested objects. */
export function patchEntityMeta(previous: EntityMeta | undefined, patch: EntityMeta | null | undefined): EntityMeta | undefined {
  if (patch === undefined) return previous;
  if (patch === null) return undefined;
  const next = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export function foldEntityContent(previous: EntityContent[], incoming: EntityContent[] | null | undefined, mode: 'replace' | 'append'): EntityContent[] {
  if (incoming === undefined) return previous;
  return mode === 'replace' ? incoming ?? [] : [...previous, ...(incoming ?? [])];
}

export function messageContentText(content: readonly EntityContent[]): string {
  return content.map(block => block.type === 'text' && typeof block.text === 'string' ? block.text : '').join('');
}
