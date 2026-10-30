import type { CreateSessionParams } from '@shared/core/sessions/create-session';
import { err, ok } from '@gugu/session-shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { generateSessionName } from './name-generation/generateSessionName';
import { getProjectWorkspaces } from './operations/getProjectWorkspaces';
import {
  recordSessionAttachments,
  resolveSessionAttachmentPath,
  type StagedSessionAttachment,
} from './attachments/session-attachment-store';
import {
  AttachmentUploadError,
  commitSessionAttachmentUpload,
  discardSessionAttachmentUpload,
  writeSessionAttachmentChunk,
  type AttachmentChunk,
  type AttachmentCommit,
} from './attachments/attachment-upload';
import { sessionService } from './session-service';
import { sessionConfigSchema } from '@shared/core/sessions/new-session-config';

/** 按块收附件的失败:带原因码(界面按码说人话),原文进日志。 */
function uploadFailure(verb: string, sessionId: string, e: unknown) {
  const message = String((e as Error)?.message || e);
  const type = e instanceof AttachmentUploadError ? e.code : ('persist_failed' as const);
  if (type === 'persist_failed') log.error(`sessions:${verb} failed`, { sessionId, error: message });
  return err({ type, message });
}

export const sessionCreateController = createRPCController({
  async createSession(params: CreateSessionParams) {
    sessionConfigSchema.parse(params.sessionConfig);
    return sessionService.createSession(params);
  },
  /**
   * #6264 输入框附件按块传(本机会话与别的机器上的会话同一条;字节可能来自另一台电脑)。
   * 见 attachments/attachment-upload.ts。
   */
  async writeAttachmentChunk(chunk: AttachmentChunk) {
    try {
      return ok(await writeSessionAttachmentChunk(chunk));
    } catch (e: unknown) {
      return uploadFailure('writeAttachmentChunk', chunk.sessionId, e);
    }
  },
  async commitAttachmentUpload(commit: AttachmentCommit) {
    try {
      return ok(await commitSessionAttachmentUpload(commit));
    } catch (e: unknown) {
      return uploadFailure('commitAttachmentUpload', commit.sessionId, e);
    }
  },
  async discardAttachmentUpload(input: { sessionId: string; uploadId: string }) {
    try {
      await discardSessionAttachmentUpload(input);
      return ok(undefined);
    } catch (e: unknown) {
      return uploadFailure('discardAttachmentUpload', input.sessionId, e);
    }
  },
  /**
   * 消息里那条 mention 指着的东西,显示与点开该读哪一份(#5269)。
   * 有我们自己的副本就用副本 —— 原路径依赖「文件还在不在 / 在不在 home 里」,而 home 之外
   * `openPath` 直接判死。查不到就原样返回(工作区文件的 mention 走的正是这一支)。
   */
  async resolveAttachmentPath(sessionId: string, target: string) {
    try {
      return ok(await resolveSessionAttachmentPath(sessionId, target));
    } catch (e: unknown) {
      const message = String((e as Error)?.message || e);
      log.warn('sessions:resolveAttachmentPath failed', { sessionId, error: message });
      return ok(target);
    }
  },
  /** 会话建出来之后补登记上面那几件。 */
  async recordAttachments(sessionId: string, entries: StagedSessionAttachment[]) {
    try {
      await recordSessionAttachments(sessionId, entries);
      return ok(undefined);
    } catch (e: unknown) {
      const message = String((e as Error)?.message || e);
      log.error('sessions:recordAttachments failed', { sessionId, error: message });
      return err({ type: 'persist_failed' as const, message });
    }
  },
  async getProjectWorkspaces(projectId: string) {
    return getProjectWorkspaces(projectId);
  },
  async provisionWorkspace(sessionId: string) {
    return sessionService.provisionWorkspace(sessionId);
  },
  generateSessionName,
});
