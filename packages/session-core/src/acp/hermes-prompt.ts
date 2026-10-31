import { createHash } from 'node:crypto';

/** Same text projection as Hermes' submit path, including resources. Images remain separate attachments. */
export function hermesPromptText(blocks: unknown): { text: string; images: { data: string; mimeType: string }[] } {
  const list = Array.isArray(blocks) ? blocks as Record<string, unknown>[] : [];
  const texts: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  for (const block of list) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image' && typeof block.data === 'string') images.push({ data: block.data, mimeType: String(block.mimeType ?? 'image/png') });
    else if (block.type === 'resource_link' && typeof block.uri === 'string') texts.push(block.uri);
    else if (block.type === 'resource' && typeof (block.resource as Record<string, unknown> | undefined)?.text === 'string') texts.push(String((block.resource as Record<string, unknown>).text));
  }
  return { text: texts.join('\n'), images };
}

const HOST_PROMPT_HASH = 'gugu.hermesNativePromptSha256';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const hermesPromptMeta = (blocks: unknown): Record<string, string> => ({ [HOST_PROMPT_HASH]: hash(hermesPromptText(blocks).text) });
export type HermesPromptIndex = ReadonlyMap<string, string | null>;

/** Only host-persisted user rows supply a boundary; a provider row or a tag name cannot supply one. */
export function indexHermesPrompts(messages: Iterable<{ kind: string; role?: string; text?: string; _meta?: Record<string, unknown> }>): HermesPromptIndex {
  const index = new Map<string, string | null>();
  for (const item of messages) {
    const digest = item._meta?.[HOST_PROMPT_HASH];
    if (item.kind !== 'message' || item.role !== 'user' || typeof item.text !== 'string' || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) continue;
    // Identical flattened bytes can have two original block boundaries. Do not guess in that case.
    if (index.has(digest) && index.get(digest) !== item.text) index.set(digest, null);
    else index.set(digest, item.text);
  }
  return index;
}

export function originalHermesPrompt(nativeText: string, index: HermesPromptIndex): string | null | undefined {
  return index.get(hash(nativeText));
}
