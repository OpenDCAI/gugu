import type { SessionPatch } from '../session-protocol';
import type { EntityContent } from './entity-content';
import type { ToolImage } from './turns/tool-calls';

/** Shared display formatting for decoded tool payloads. */
export function serializePayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

export function toolOutputText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text.trim());
  return match ? match[1] : text;
}

/** Read the recorded answer, before display formatting strips a code fence. */
export function hasRecordedAnswers(output: string | null | undefined): boolean {
  if (output == null) return false;
  try {
    const answers = JSON.parse(output)?.answers;
    return answers !== null && typeof answers === 'object' && !Array.isArray(answers) && Object.keys(answers).length > 0;
  } catch {
    return false;
  }
}

/** A picture block that `projectToolContent` reads into `images`. */
function isToolImageBlock(block: Record<string, unknown>): block is Record<string, unknown> & ToolImage {
  return block.type === 'image' && typeof block.data === 'string' && block.data !== ''
    && typeof block.mimeType === 'string' && block.mimeType.startsWith('image/');
}

/** Tool views are projections of blocks, including after replacement or clearing. */
export function projectToolContent(content: readonly EntityContent[]) {
  const texts: string[] = [];
  const images: ToolImage[] = [];
  let terminalId: string | undefined;
  const diffs: SessionPatch[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const block = value as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (isToolImageBlock(block)) images.push({ data: block.data, mimeType: block.mimeType });
    else if (block.type === 'terminal' && typeof block.terminalId === 'string') terminalId ??= block.terminalId;
    else if (block.content !== undefined) visit(block.content);
    else if (block.type === 'diff' && Array.isArray(block.changes)) diffs.push(block as unknown as SessionPatch);
  };
  content.forEach(visit);
  return { outputText: toolOutputText(texts.join('\n')), images, diffs, terminalId };
}

/**
 * A tool's pictures are kept once, in its `images` (#980). A screenshot used to be stored three times per call: in the
 * content blocks, in `images`, and as base64 inside the provider's `rawOutput` — up to ~35 MB in one stored turn.
 *
 * `withoutToolImages` drops from the blocks the pictures `projectToolContent` reads into `images`, wrapper included.
 * No view reads a picture from the blocks; the reducer puts them back from `images` before it appends (tool-patch).
 */
export function withoutToolImages(content: readonly EntityContent[]): EntityContent[] {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip).filter((one) => one !== undefined);
    if (!value || typeof value !== 'object') return value;
    const block = value as Record<string, unknown>;
    if (isToolImageBlock(block)) return undefined;
    // Same order as the projection: a text or terminal block is never looked into.
    if ((block.type === 'text' && typeof block.text === 'string')
      || (block.type === 'terminal' && typeof block.terminalId === 'string')
      || block.content === undefined) return value;
    const inner = strip(block.content);
    return inner === undefined ? undefined : inner === block.content ? value : { ...block, content: inner };
  };
  return strip(content) as EntityContent[];
}

/** The note that stands in a payload for a picture kept in `images`. Plain ASCII without quotes, so the JSON stays valid. */
export function toolImageNote(index: number, image: ToolImage): string {
  return `[image ${index + 1}: ${image.data.length} base64 chars]`;
}

/**
 * A serialized payload (`rawOutput`, or a result disclosed whole as text) with every JSON string that is exactly one of
 * `images` replaced by `toolImageNote` (#980). Only a whole string value is replaced, so the payload keeps its shape and
 * nothing else in it changes; a provider that encodes the picture differently there keeps its payload as it was.
 */
export function payloadWithoutImages(payload: string, images: readonly ToolImage[]): string {
  let next = payload;
  images.forEach((image, index) => {
    const quoted = JSON.stringify(image.data);
    if (next.includes(quoted)) next = next.split(quoted).join(JSON.stringify(toolImageNote(index, image)));
  });
  return next;
}
