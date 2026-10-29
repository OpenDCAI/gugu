import { createHash } from 'node:crypto';

/** Keep complete entity payloads covered without repeating megabytes already in the wire fixture. */
export function entitySnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entitySnapshot);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, child]) => {
    const canonical = key === 'contentBlocks' || key === '_meta'
      || key === 'content' && (record.kind === 'message' || record.kind === 'thinking');
    return [key, canonical ? {
      sha256: createHash('sha256').update(JSON.stringify(child)).digest('hex'),
      ...(Array.isArray(child) ? { blocks: child.length } : {}),
    } : entitySnapshot(child)];
  }));
}
