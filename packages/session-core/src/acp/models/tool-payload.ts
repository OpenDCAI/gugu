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

/** Tool views are projections of blocks, including after replacement or clearing. */
export function projectToolContent(content: readonly EntityContent[]) {
  const texts: string[] = [];
  const images: ToolImage[] = [];
  let terminalId: string | undefined;
  const diffs: Array<{ path: string; oldText: string | null; newText: string }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const block = value as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image' && typeof block.data === 'string' && block.data && typeof block.mimeType === 'string' && block.mimeType.startsWith('image/')) images.push({ data: block.data, mimeType: block.mimeType });
    else if (block.type === 'terminal' && typeof block.terminalId === 'string') terminalId ??= block.terminalId;
    else if (block.content !== undefined) visit(block.content);
    else if (block.type === 'diff' && typeof block.path === 'string' && typeof block.newText === 'string') diffs.push({ path: block.path, oldText: typeof block.oldText === 'string' ? block.oldText : null, newText: block.newText });
  };
  content.forEach(visit);
  return { outputText: toolOutputText(texts.join('\n')), images, diffs, terminalId };
}
