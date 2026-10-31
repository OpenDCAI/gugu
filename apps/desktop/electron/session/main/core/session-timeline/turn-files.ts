import { join } from 'node:path';
import { attachmentMimeTypeSchema, type PromptAttachment } from '@gugu/session-core/acp/client';
import type { TurnFileRef } from '@gugu/session-core/session-record/contract';
import { turnAttachmentText } from '@gugu/core/shared/attachmentFolderLine';
import { attachmentFailureReason } from '@gugu/core/local/files/attachmentDiagnostics';
import { saveFileHandle } from '@gugu/core/local/files/fileSnapshots';
import { resolveGuguHome } from '@gugu/core/local/state/paths';
import { resolveAccountFile } from '@main/core/extensions/account-token';
import { guguAgentUserIdForSession } from '@main/core/sessionpage/sessionpage-session-agent';
import { readCachedDeviceId } from '@gugu/core/cloud/deviceRuntime';

/**
 * A task turn's attachments, for its agent (P3): each one is a file of the agent's DM folder, placed there by the owner.
 * The agent reads the same lines as for an attachment delivered from a chat (`attachmentLocationLines`), so it cannot
 * tell which door a file came through; an image an ACP agent can take is also handed inline.
 *
 * Read as the session's agent. Where this device keeps the version, the agent works on the file it was placed from
 * (`path`), never on the version itself; elsewhere the version is fetched once (the resolver's own SSH, then a temporary
 * transfer) into the directory agents' downloads land in.
 */
export async function turnFileText(sessionId: string, files: readonly TurnFileRef[], inlineImages: boolean): Promise<{ text: string; images: PromptAttachment[] }> {
  const agent = await guguAgentUserIdForSession(sessionId, process.env);
  const parts: string[] = [];
  const images: PromptAttachment[] = [];
  for (const file of files) {
    let saved: Parameters<typeof turnAttachmentText>[1];
    try {
      if (!agent) throw new Error('This task has no agent identity to read its attachments as');
      saved = { localPath: await localPathOf(file, agent) };
    } catch (error) {
      saved = { failure: attachmentFailureReason(error) };
    }
    parts.push(turnAttachmentText(file, saved));
    const inline = attachmentMimeTypeSchema.safeParse(file.mimeType);
    if (inlineImages && 'localPath' in saved && inline.success) {
      images.push({ type: 'local-file', originalPath: saved.localPath, mimeType: inline.data, name: file.name });
    }
  }
  return { text: parts.join('\n\n'), images };
}

async function localPathOf(file: TurnFileRef, agent: string): Promise<string> {
  // Read as the agent, like any file it reads: the folder's membership says whether it may; the resolver says where the
  // bytes are (this device, its own SSH, or a temporary transfer).
  const resolved = await resolveAccountFile({ id: file.itemId }, agent, { version: file.version });
  if (!resolved || resolved.status !== 'ready') throw new Error('File is no longer available');
  const { revision, reader } = resolved;
  if (file.path && revision.source === 'local' && revision.host_device_id === await readCachedDeviceId(process.env, reader.accountId)) {
    await resolved.dispose();
    return file.path;
  }
  return (await saveFileHandle(resolved, join(resolveGuguHome(process.env), 'attachments'), file.name)).file_path;
}
