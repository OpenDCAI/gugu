import { join } from 'node:path';
import { log } from '@main/lib/logger';
import { runtimeFork } from '../sessions/session-life-forks';
import { attachmentMimeTypeSchema, type PromptAttachment } from '@gugu/session-core/acp/client';
import type { TurnFileRef } from '@gugu/session-core/session-record/contract';
import { turnAttachmentText } from '@gugu/core/shared/attachmentFolderLine';
import { attachmentFailureReason } from '@gugu/core/local/files/attachmentDiagnostics';
import { saveFileHandle } from '@gugu/core/local/files/fileSnapshots';
import { resolveGuguHome } from '@gugu/core/local/state/paths';
import { resolveAccountFile } from '@main/core/extensions/account-token';
import { guguAgentUserIdForSession } from '@main/core/sessionpage/sessionpage-session-agent';
import { readCachedDeviceId } from '@gugu/core/cloud/deviceRuntime';
import { stat } from 'node:fs/promises';

const prefetched = new Map<string, string>();
const fileKey = (sessionId: string, file: TurnFileRef) => JSON.stringify([sessionId, file.itemId, file.version]);

export async function prefetchFiles(input: { conversationId: string; files: TurnFileRef[] }) {
  const agent = await guguAgentUserIdForSession(input.conversationId, process.env);
  return Promise.all(input.files.map(async file => {
    try {
      if (!agent) throw new Error('This task has no agent identity to read its attachments as');
      const path = await localPathOf(file, agent, input.conversationId);
      prefetched.set(fileKey(input.conversationId, file), path);
      return { itemId: file.itemId, ok: true as const };
    } catch (error) {
      return { itemId: file.itemId, ok: false as const, error: attachmentFailureReason(error), code: (error as { code?: string })?.code };
    }
  }));
}

/**
 * A task turn's attachments, for its agent (P3): each one is a file of the agent's DM folder, placed there by the owner.
 * The agent reads the same lines as for an attachment delivered from a chat (`attachmentLocationLines`), so it cannot
 * tell which door a file came through; an image an ACP agent can take is also handed inline.
 *
 * Read as the session's agent. Where this device keeps the version, the agent works on the file it was placed from
 * (`path`), never on the version itself; elsewhere the version is fetched once (the resolver's own SSH, then a temporary
 * transfer) into the directory agents' downloads land in.
 */
export async function turnFileText(sessionId: string, files: readonly TurnFileRef[], inlineImages: boolean, replayImages: readonly PromptAttachment[] = []): Promise<{ text: string; images: PromptAttachment[]; files: import('@gugu/session-core/acp/client').PromptInput['files'] }> {
  const agent = await guguAgentUserIdForSession(runtimeFork(sessionId)?.parentId ?? sessionId, process.env);
  const parts: string[] = [];
  const images: PromptAttachment[] = [];
  const prepared: NonNullable<import('@gugu/session-core/acp/client').PromptInput['files']> = [];
  for (const file of files) {
    let saved: Parameters<typeof turnAttachmentText>[1];
    try {
      if (!agent) throw new Error('This task has no agent identity to read its attachments as');
      saved = { localPath: await localPathOf(file, agent, sessionId) };
    } catch (error) {
      saved = { failure: attachmentFailureReason(error) };
      log.warn('Task attachment could not be saved', { sessionId, itemId: file.itemId, reason: saved.failure });
    }
    const promptText = turnAttachmentText(file, saved);
    parts.push(promptText);
    prepared.push({ ...file, promptText });
    const inline = attachmentMimeTypeSchema.safeParse(file.mimeType);
    if (inlineImages && 'localPath' in saved && inline.success && !replayImages.some(image => image.name === file.name)) {
      images.push({ type: 'local-file', originalPath: saved.localPath, mimeType: inline.data, name: file.name });
    }
  }
  return { text: parts.join('\n\n'), images, files: prepared };
}

async function localPathOf(file: TurnFileRef, agent: string, sessionId: string): Promise<string> {
  const key = fileKey(sessionId, file), cached = prefetched.get(key);
  if (cached && (await stat(cached).catch(() => null))?.isFile()) return cached;
  prefetched.delete(key);
  if (file.workspacePath) {
    if (!file.workspacePath.startsWith('.gugu/attachments/')) throw new Error('The SSH attachment is outside its directory');
    const [{ db }, { sessions, workspaces, projects }, { eq }, { inWorkspace }] = await Promise.all([
      import('@main/db/client'), import('@main/db/schema'), import('drizzle-orm'), import('../files/workspace-transfer'),
    ]);
    const row = db.select({ workspace: workspaces.path, project: projects.path }).from(sessions)
      .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id)).innerJoin(projects, eq(sessions.projectId, projects.id))
      .where(eq(sessions.id, runtimeFork(sessionId)?.parentId ?? sessionId)).get();
    if (!row) throw new Error('The task workspace is not available');
    const path = await inWorkspace(row.workspace ?? row.project, file.workspacePath);
    const info = await stat(path);
    if (!info.isFile() || info.size !== file.sizeBytes) throw new Error('The SSH attachment changed');
    return path;
  }
  // Read as the agent, like any file it reads: the folder's membership says whether it may; the resolver says where the
  // bytes are (this device, its own SSH, or a temporary transfer).
  const resolved = await resolveAccountFile({ id: file.itemId }, agent, { version: file.version });
  if (!resolved || resolved.status !== 'ready') throw new Error('File is no longer available');
  const { revision, reader } = resolved;
  if (file.path && revision.source === 'local' && revision.host_device_id === await readCachedDeviceId(process.env, reader.accountId)
    && (await stat(file.path).catch(() => null))?.isFile()) {
    await resolved.dispose();
    return file.path;
  }
  const path = (await saveFileHandle(resolved, join(resolveGuguHome(process.env), 'attachments', sessionId), file.name)).file_path;
  prefetched.set(key, path);
  return path;
}
