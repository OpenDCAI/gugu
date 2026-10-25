import * as path from 'node:path';
import type { AppReadFileAction, RemoteAppCaller } from '@gugu/session-core/session-record/contract';
import { AppFileError, contentTypeOf } from '@shared/extensions/app-files-core';
import { APP_FILE_MAX_BYTES, fileSuffixOf, fileTypeOf, type AppFileEntry } from '@shared/extensions/app-runtime-protocol';
import { readRemotePreviewBytes } from '@main/core/files/remote-preview-read';
import type { WorkspaceChunk } from '@main/core/files/workspace-transfer';
import { log } from '@main/lib/logger';

/**
 * `gugu.files` on a session of the person's other machine, read only (`files:read:all-machines`): open and download, no
 * live document across machines. The session is found the way an App's message finds it (`sessionsElsewhere`); the file
 * comes over #6264's chunks, each read there inside the working copy (`readWorkspaceChunk`).
 */

/** A file of a session on another machine, whole: its bytes and its entry, named by its path in that working copy. */
export async function readElsewhere(
  app: { extensionId: string; extensionName: string },
  sessionId: string,
  rel: string,
): Promise<{ entry: AppFileEntry; bytes: Uint8Array }> {
  const { sessionsElsewhere } = await import('@main/core/extensions/extension-agents');
  const { rows, unreached } = await sessionsElsewhere();
  const row = rows.find(({ session }) => session.conversationId === sessionId);
  const deviceId = row?.deviceId;
  if (!deviceId) {
    // not-found only when every machine answered without it; one not read (offline, silent, too old) leaves it open.
    const tail = unreached.length ? ` (not read: ${unreached.map((machine) => machine.label ?? machine.detail).join(', ')})` : '';
    throw new AppFileError(unreached.length ? 'failed' : 'not-found', `Session ${sessionId} is not on this computer or on your other online computers${tail}`);
  }
  const { otherMachines } = await import('@main/core/sessions/session-family');
  let refused: unknown = null;
  const read = await readRemotePreviewBytes(
    (chunk) =>
      otherMachines().appReadFile(app, deviceId, { action: 'read_file', session_id: sessionId, ...chunk }).catch((error: unknown) => {
        refused = error;
        throw error;
      }),
    rel,
    APP_FILE_MAX_BYTES,
  );
  if (!read.ok) {
    if (read.reason === 'too_large') throw new AppFileError('too-large', `${rel} is over the ${APP_FILE_MAX_BYTES / 1024 / 1024} MB of an open file`);
    if (read.reason === 'changing') throw new AppFileError('failed', `${rel} kept changing while it was read; open it again when it is written`);
    // That machine's refusal keeps its code (a working copy's, the machine named); anything else on the way there — too
    // old, no answer — is failed, naming the machine.
    const code = (refused as { code?: unknown } | null)?.code;
    if (code === 'not-found' || code === 'invalid' || code === 'failed') throw refused;
    throw new AppFileError('failed', `Could not read ${rel} from "${row?.deviceLabel ?? deviceId}" (${String(code ?? 'no code')})`);
  }
  const name = path.posix.basename(rel);
  const contentType = contentTypeOf(name);
  return {
    bytes: read.bytes,
    entry: {
      id: rel,
      session: sessionId,
      name,
      contentType,
      type: fileTypeOf('file', contentType),
      parentId: null,
      path: rel,
      systemRole: null,
      // Read from another machine: removed there, not from here.
      canDelete: false,
      suffix: fileSuffixOf({ name, contentType }),
      displayName: name,
      claimedBy: null,
      size: read.bytes.byteLength,
      version: null,
      createdAt: null,
      updatedAt: null,
      createdBy: null,
      updatedBy: null,
      sourceMessageIds: [],
    },
  };
}

/**
 * The other side: an App on another machine (granted `files:read:all-machines` there) reads a chunk of a working copy
 * here. It refuses with the codes a working copy here answers with, and names the file by the path asked for — never by
 * this machine's absolute path.
 */
export async function answerAppReadFile(caller: RemoteAppCaller, action: AppReadFileAction): Promise<WorkspaceChunk> {
  const { agentSessionContext } = await import('@main/core/extensions/extension-agent-context');
  const root = (await agentSessionContext(action.session_id))?.workspaceRoot;
  if (!root) throw new AppFileError('not-found', `Session ${action.session_id} has no working copy open on its machine`);
  const rel = action.path;
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) throw new AppFileError('invalid', 'Say which file by its path in the working copy');
  const { readWorkspaceChunk } = await import('@main/core/files/workspace-transfer');
  const chunk = await readWorkspaceChunk(root, action).catch((error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'not_a_file') throw new AppFileError('invalid', `${rel} is not a file`);
    if (code === 'not_found' || code === 'outside_workspace') throw new AppFileError('not-found', `No file ${JSON.stringify(rel)} in that working copy`);
    throw new AppFileError('failed', `${rel} could not be read (${String(code)})`);
  });
  if (chunk.offset === 0) log.info('[app-files] a file read for an App on another machine', { device: caller.deviceId, app: caller.extensionId, session: action.session_id, path: rel, size: chunk.size });
  return { ...chunk, path: rel };
}
