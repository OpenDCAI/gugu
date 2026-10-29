import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveGuguHome } from '@gugu/core/local/state/paths';
import { log } from '@main/lib/logger';
import { encodeResult, withPictures } from '../../../../mcp/sessionpage-tool-result';
import { stringifyMention } from '@gugu/session-shared/markdown';

export type HumanToolKind = `app_${string}`;
type HumanToolPicture = { label: string; mime_type: string; file_path: string };
export type HumanToolRecord = {
  id: string;
  requestId: string;
  sessionId: string;
  tool: HumanToolKind;
  messageId: string;
  state: 'waiting' | 'finished';
  paused?: boolean;
  result?: unknown;
  encoded?: true;
  pictures?: HumanToolPicture[];
  picturesError?: string;
};

function file(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid human tool session ID');
  return join(resolveGuguHome(), 'human-tool-results', `${sessionId}.json`);
}
export function readHumanToolRecords(sessionId: string): HumanToolRecord[] {
  let raw: string;
  try { raw = readFileSync(file(sessionId), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const data = JSON.parse(raw) as { version: number; items: HumanToolRecord[] };
  if (data.version !== 1 || !Array.isArray(data.items) || data.items.some(item =>
    item.sessionId !== sessionId || !['waiting', 'finished'].includes(item.state)
    || typeof item.tool !== 'string' || !/^[a-z][a-z_]*$/.test(item.tool)
    || !item.id || !item.requestId || !item.messageId)) throw new Error('Invalid human tool result records');
  // Retired tools are not replayed and must not block outcomes for the remaining App tools.
  return data.items.filter(item => /^app_[a-z][a-z_]*$/.test(item.tool));
}
function write(sessionId: string, items: HumanToolRecord[]): void {
  const target = file(sessionId);
  mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, items }) + '\n', { mode: 0o600 });
    renameSync(temp, target);
  } catch (error) { try { unlinkSync(temp); } catch { /* Keep the write failure. */ } throw error; }
}
export function saveHumanToolRecord(record: HumanToolRecord): void {
  write(record.sessionId, [...readHumanToolRecords(record.sessionId).filter(item => item.id !== record.id), record]);
}

/** The synchronous tool boundary owns ID/picture encoding. Durable replies reuse it before persisting.
 * This text-only outbox carries stable local image references; image bytes stay in binary files. */
export function prepareHumanToolResult(record: HumanToolRecord, result: unknown): HumanToolRecord {
  if (record.encoded) return record;
  const encoded = encodeResult(result);
  let shown = encoded;
  let picturesError: string | undefined;
  let picturePhase: 'validation' | 'storage' = 'validation';
  const saved: HumanToolPicture[] = [];
  try {
    const split = withPictures(encoded);
    shown = split.shown;
    picturePhase = 'storage';
    let label = '';
    for (const picture of split.pictures) {
      if (picture.type === 'text') { label = picture.text.slice('Picture: '.length); continue; }
      const directory = join(resolveGuguHome(), 'human-tool-results', record.sessionId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const suffix = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[picture.mimeType] ?? 'bin';
      const target = join(directory, `${record.id}-${saved.length}.${suffix}`);
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, Buffer.from(picture.data, 'base64'), { mode: 0o600 });
      renameSync(temp, target);
      saved.push({ label, mime_type: picture.mimeType, file_path: target });
    }
  } catch (error) {
    picturesError = picturePhase === 'validation'
      ? 'Result pictures were invalid and could not be attached.'
      : 'Result pictures could not be saved and were not attached.';
    // A picture failure must not lose the actual tool outcome or inline the rejected bytes.
    if (encoded && typeof encoded === 'object' && !Array.isArray(encoded)) {
      shown = Object.fromEntries(Object.entries(encoded).filter(([key]) => key !== 'pictures'));
    }
    saved.length = 0;
    log.warn('Human tool pictures could not be attached', { sessionId: record.sessionId, requestId: record.requestId, error: String(error) });
  }
  return { ...record, state: 'finished', result: shown, encoded: true, ...(saved.length ? { pictures: saved } : {}),
    ...(picturesError ? { picturesError } : {}) };
}

const delivering = new Map<string, Promise<void>>();
/** Stable clientMessageId hands responsibility to the existing durable session outbox, exactly once. */
export function deliverHumanToolResult(record: HumanToolRecord, projectId?: string): Promise<void> {
  const previous = delivering.get(record.id);
  if (previous) return previous;
  const operation = (async () => {
    // Also migrate a pre-fix finished record before retrying it. Never encode typed IDs twice.
    record = prepareHumanToolResult(record, record.result);
    saveHumanToolRecord(record);
    const project = projectId ?? (await import('../session-timeline/service')).readSessionRow(record.sessionId)?.projectId;
    if (!project) throw new Error('Human tool result has no session project');
    const { sendMessage } = await import('../sessions/sendMessage');
    const payload = JSON.stringify({ tool: record.tool, request_id: record.requestId, state: 'finished', result: record.result,
      ...(record.picturesError ? { pictures_error: record.picturesError } : {}),
      ...(record.pictures ? { pictures: record.pictures } : {}) }).replaceAll('<', '\\u003c');
    const pictures = record.pictures?.map(picture => stringifyMention({ kind: 'file', label: picture.label, target: picture.file_path })).join('\n');
    await sendMessage({ sessionId: record.sessionId, projectId: project, clientMessageId: record.messageId,
      kind: 'session-direct', text: `<gugu_human_tool_result>\n${payload}\n</gugu_human_tool_result>\nThis is the actual outcome of the original human request. Pending was not approval. Continue only the corresponding work.${pictures ? `\nRead the attached local pictures to inspect the result:\n${pictures}` : ''}`,
    });
    write(record.sessionId, readHumanToolRecords(record.sessionId).filter(item => item.id !== record.id));
  })();
  delivering.set(record.id, operation);
  void operation.finally(() => delivering.delete(record.id)).catch(() => undefined);
  return operation;
}

export function reportHumanToolDelivery(record: HumanToolRecord, projectId?: string): void {
  void deliverHumanToolResult(record, projectId).catch((error: unknown) =>
    log.error('Human tool result remains durable for retry', { sessionId: record.sessionId, requestId: record.requestId, error: String(error) }));
}
