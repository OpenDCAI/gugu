import { foldEntityContent, patchEntityMeta, type EntityContent } from '../models/entity-content';
import { projectToolContent, payloadWithoutImages, withoutToolImages } from '../models/tool-payload';
import type { ToolCallItem } from '../models/turns';
import type { NormalizedEvent } from './normalized-event';

type ToolEvent = Extract<NormalizedEvent, { kind: 'tool_call' | 'tool_update' }>;

/**
 * The blocks an incoming chunk is appended to. Pictures are kept in `images`, not in the blocks (#980), so they go back
 * in here; a call folded before that still has them in its blocks and keeps them as they are.
 */
function priorContent(item: ToolCallItem): EntityContent[] {
  const blocks = item.contentBlocks
    ?? (item.outputText !== undefined ? [{ type: 'content', content: { type: 'text', text: item.outputText } }] : []);
  if (!item.images?.length || projectToolContent(blocks).images.length) return blocks;
  return [...blocks, ...item.images.map(image => ({ type: 'content', content: { type: 'image', ...image } }))];
}

/** Omission keeps state; null removes state, including every derived display field. */
export function patchToolEntity(item: ToolCallItem, event: ToolEvent): ToolCallItem {
  const next = { ...item };
  const fields = next as unknown as Record<string, unknown>;
  for (const key of ['toolName', 'toolKind', 'rawInput', 'rawOutput', 'inputSummary', 'terminalId', 'exitStatus', 'parentToolCallId', 'backgroundTaskId', 'backgroundTaskDone'] as const) {
    const value = (event as unknown as Record<string, unknown>)[key];
    if (value === null) delete fields[key];
    else if (value !== undefined) fields[key] = value;
  }
  if (event.title !== undefined) next.title = event.title ?? '';
  if (event.locations !== undefined) {
    next.locations = event.locations ?? [];
    if (next.kind === 'read-tool-call') {
      if (next.locations[0]) next.path = next.locations[0].path;
      else delete next.path;
    }
  }
  if (event.status !== undefined) next.status = event.status === null ? 'unknown' : event.status === 'completed' ? 'done' : event.status === 'failed' ? 'error' : 'running';
  const meta = patchEntityMeta(item._meta, event._meta);
  if (meta === undefined) delete next._meta;
  else next._meta = meta;

  if (event.contentBlocks !== undefined) {
    const mode = event.kind === 'tool_update' ? event.contentMode ?? 'replace' : 'replace';
    const content = foldEntityContent(mode === 'append' ? priorContent(item) : [], event.contentBlocks, mode);
    const projection = projectToolContent(content);
    next.contentBlocks = projection.images.length ? withoutToolImages(content) : content;
    delete next.outputText;
    delete next.images;
    delete fields.terminalId;
    if (projection.terminalId !== undefined) fields.terminalId = projection.terminalId;
    if (projection.outputText !== undefined) next.outputText = projection.outputText;
    if (projection.images.length) next.images = projection.images;
  } else {
    for (const key of ['outputText', 'images'] as const) {
      const value = event[key];
      if (value === null) delete fields[key];
      else if (value !== undefined) fields[key] = value;
    }
  }
  // The provider's own copy of a picture (Claude's `source.data`, Codex's `data`) is the base64 `images` holds (#980);
  // so is a native record's whole result disclosed as text (#6020).
  const touched = event.rawOutput !== undefined || event.outputText !== undefined
    || event.contentBlocks !== undefined || event.images !== undefined;
  if (touched && next.images?.length) {
    if (next.rawOutput) next.rawOutput = payloadWithoutImages(next.rawOutput, next.images);
    if (next.outputText) next.outputText = payloadWithoutImages(next.outputText, next.images);
  }
  return next;
}
