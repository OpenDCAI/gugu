import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { and, desc, eq, like } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions, sessionTurns } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { resolveWorkspace } from '../projects/utils';
import { createAttachmentUploads } from '../files/attachment-uploads';
import { ATTACHMENT_UPLOAD_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import type { TranscriptMessage, TranscriptTurn } from '@gugu/session-core/acp/client';
import { noteNativeConversationReplies } from './session-conversation-read';
import { renumberStoredTurn, withStoredTurns } from './session-turn-store';
import { readCurrentTurnIdentity } from './session-activity-source';
import { setOwnerNotificationHead } from './owner-notification-state';
export { ownerNotificationHead } from './owner-notification-state';

export type OwnerNotificationInput = {
  request_id: string; agent_user_id: string; text: string;
  file?: { path: string; name: string; mime_type: string };
};
type Context = { sessionId: string; projectId: string; workspaceId: string };
const uploads = createAttachmentUploads();
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function snapshotFile(root: string, input: OwnerNotificationInput): Promise<NonNullable<TranscriptMessage['ownerNotification']>['files']> {
  if (!input.file) return undefined;
  if (!isAbsolute(input.file.path)) throw new Error('owner notification file_path must be absolute');
  const source = await open(input.file.path, 'r');
  let bytes: Buffer;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size > 25 * 1024 * 1024) throw new Error('owner notification file must be a regular file of at most 25 MiB');
    bytes = await source.readFile();
    const after = await source.stat();
    if (bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('owner notification file changed while reading');
  } finally { await source.close(); }
  const spec = { uploadId: `owner-notify-${input.request_id}`, itemId: input.request_id, name: input.file.name, size: bytes.length, sha256: hash(bytes) };
  const begun = await uploads.begin(root, spec);
  for (let offset = begun.received; offset < bytes.length; offset += ATTACHMENT_UPLOAD_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + ATTACHMENT_UPLOAD_CHUNK_BYTES);
    await uploads.write(root, { ...spec, offset, data: chunk.toString('base64'), chunkSha256: hash(chunk) });
  }
  const saved = await uploads.commit(root, spec);
  return [{ path: join(root, saved.workspacePath), name: input.file.name, mimeType: input.file.mime_type, sizeBytes: bytes.length, sha256: spec.sha256 }];
}

/** The host supplies the caller coordinates and revalidates identity immediately before committing. */
export async function commitOwnerNotification(context: Context, input: OwnerNotificationInput, beforeCommit: () => Promise<void>, signal?: AbortSignal) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.request_id)
    || typeof input.text !== 'string' || (!input.text.trim() && !input.file)) throw new Error('Invalid owner notification');
  const row = db.select().from(sessions).where(and(eq(sessions.id, context.sessionId), eq(sessions.projectId, context.projectId))).get();
  if (!row || row.archivedAt || row.workspaceId !== context.workspaceId) throw new Error('The sending native session is missing, archived, or no longer bound to this workspace');
  if (row.runtime !== 'acp') throw new Error('This PTY session does not support native owner notifications. This message was not delivered to your owner.');
  const workspace = input.file ? await resolveWorkspace(context.projectId, context.workspaceId) : null;
  if (input.file && !workspace) throw new Error('The sending session workspace is not mounted');
  const sourceId = `owner-notify:${input.request_id}`;
  const requestHash = hash(Buffer.from(JSON.stringify([input.agent_user_id, input.text, input.file?.path, input.file?.name, input.file?.mime_type])));
  return withStoredTurns(context.sessionId, async () => {
    signal?.throwIfAborted();
    await beforeCommit();
    const existing = db.select().from(sessionTurns).where(and(eq(sessionTurns.sessionId, context.sessionId), eq(sessionTurns.turnId, sourceId))).get();
    if (existing) {
      const previous = (JSON.parse(existing.data) as TranscriptTurn).items[0];
      if (previous?.kind !== 'message' || previous.ownerNotification?.requestHash !== requestHash) throw new Error('Owner notification request_id was already committed with different content');
      return { status: 'sent' as const, message_id: input.request_id, session_id: context.sessionId, seq: existing.seq, ...(previous.ownerNotification.files?.[0] ? { file_name: previous.ownerNotification.files[0].name } : {}) };
    }
    const sourceTurnId = await readCurrentTurnIdentity(context.sessionId);
    const files = input.file ? await snapshotFile(workspace!.path, input) : undefined;
    await beforeCommit();
    signal?.throwIfAborted();
    const at = Date.now();
    let publish: (() => void) | undefined;
    const seq = db.transaction(tx => {
      const current = tx.select().from(sessions).where(eq(sessions.id, context.sessionId)).get();
      if (!current || current.archivedAt || current.projectId !== context.projectId || current.workspaceId !== context.workspaceId) throw new Error('The sending session changed before the owner notification committed');
      const tail = tx.select({ seq: sessionTurns.seq }).from(sessionTurns).where(eq(sessionTurns.sessionId, context.sessionId)).orderBy(desc(sessionTurns.seq)).limit(1).get();
      const next = (tail?.seq ?? -1) + 1;
      const turn = renumberStoredTurn({ id: sourceId, seq: next, initiator: 'agent', trigger: { kind: 'agent' }, startedAt: at, endedAt: at,
        outcome: { kind: 'done' }, items: [{ kind: 'message', id: `${sourceId}:message:${input.request_id}`, seq: 0, role: 'assistant',
          text: input.text || files![0]!.name, at, ownerNotification: { requestId: input.request_id, requestHash, ...(sourceTurnId ? { sourceTurnId } : {}), ...(files ? { files } : {}) } }] }, context.sessionId, next);
      tx.insert(sessionTurns).values({ id: `${context.sessionId}:${next}`, sessionId: context.sessionId, seq: next, turnId: sourceId, data: JSON.stringify(turn) }).run();
      setOwnerNotificationHead(context.sessionId, next, tx);
      publish = noteNativeConversationReplies(context.sessionId, turn, turn, tx);
      return next;
    });
    publish?.();
    events.emit(sessionChangedChannel, { sessionId: context.sessionId, projectId: context.projectId, changes: { nativeOwnerNotificationSeq: true } });
    return { status: 'sent' as const, message_id: input.request_id, session_id: context.sessionId, seq, ...(files?.[0] ? { file_name: files[0].name } : {}) };
  });
}

/** Notification snapshots are authorized by their actual durable session message, not by arbitrary paths. */
export function ownerNotificationFile(sessionId: string, path: string): boolean {
  return db.select({ data: sessionTurns.data }).from(sessionTurns).where(and(eq(sessionTurns.sessionId, sessionId), like(sessionTurns.turnId, 'owner-notify:%'))).all().some(row =>
    (JSON.parse(row.data) as TranscriptTurn).items.some(item => item.kind === 'message' && item.ownerNotification?.files?.some(file => file.path === path)));
}
