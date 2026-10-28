import type { TranscriptItem, TranscriptTurn } from '../acp/models/turns/turn';
import { isGuguServer } from '../acp/models/turns/opened-outputs';
import { sentMessageId } from './reply-process';

/** Metadata from a confirmed send or an authorized IM row; never file bytes or a local path to open. */
export type SentAttachment = { messageId: string; name: string; href: string; caption?: string };
export type AttachmentTurn = TranscriptTurn & { sentAttachments?: Readonly<Record<string, SentAttachment>> };

function resultObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') { try { return resultObject(JSON.parse(raw)); } catch { return null; } }
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.isError === true) return null;
  if (typeof value.message_id === 'string') return value;
  if (Array.isArray(value.content)) for (const block of value.content) {
    if (block?.type === 'text') { const result = resultObject(block.text); if (result) return result; }
  }
  return null;
}

/** Only a successful root Gugu file send can become a visible attachment in the conversation. */
export function sentAttachmentOf(item: TranscriptItem, known?: Readonly<Record<string, SentAttachment>>): SentAttachment | null {
  if (item.kind !== 'mcp-tool-call' || item.status !== 'done' || item.parentToolCallId || !isGuguServer(item.server)
    || !/(?:^|__)message_send_file$/.test(item.tool)) return null;
  const id = sentMessageId(item)?.replace(/^msg:/, '');
  if (!id) return null;
  if (known?.[id]) return known[id]!;
  const output = resultObject(item.rawOutput) ?? resultObject(item.outputText);
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(item.rawInput ?? '{}') as Record<string, unknown>; } catch { /* receipt metadata is sufficient */ }
  const name = typeof output?.file_name === 'string' ? output.file_name : typeof args?.file_name === 'string' ? args.file_name
    : typeof args?.file_path === 'string' ? args.file_path.split(/[\\/]/).at(-1) : undefined;
  if (!name?.trim()) return null;
  const file = typeof output?.file === 'string' && /^gugu-file:\/\//.test(output.file) ? output.file : null;
  return { messageId: id, name, href: file ?? `gugu-message-file://${id}`, ...(typeof args?.caption === 'string' && args.caption ? { caption: args.caption } : {}) };
}
