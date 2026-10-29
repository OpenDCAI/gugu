import { foldEntityContent, patchEntityMeta } from '../models/entity-content';
import { projectToolContent } from '../models/tool-payload';
import type { ToolCallItem } from '../models/turns';
import type { NormalizedEvent } from './normalized-event';

type ToolEvent = Extract<NormalizedEvent, { kind: 'tool_call' | 'tool_update' }>;

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
    const prior = item.contentBlocks ?? [
      ...(item.outputText !== undefined ? [{ type: 'content', content: { type: 'text', text: item.outputText } }] : []),
      ...(item.images ?? []).map(image => ({ type: 'content', content: { type: 'image', ...image } })),
    ];
    const mode = event.kind === 'tool_update' ? event.contentMode ?? 'replace' : 'replace';
    next.contentBlocks = foldEntityContent(prior, event.contentBlocks, mode);
    const projection = projectToolContent(next.contentBlocks);
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
  return next;
}
