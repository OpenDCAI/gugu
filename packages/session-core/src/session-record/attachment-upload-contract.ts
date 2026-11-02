/** The existing task-file payload remains compatible independently of new upload verbs. */
export const TASK_ATTACHMENT_PROTOCOL = 16;
/** A resumable task file, scoped by the receiving workspace. */
export const ATTACHMENT_UPLOAD_CHUNK_BYTES = 128 * 1024;
export const ATTACHMENT_UPLOAD_PROTOCOL = 17;
export type AttachmentUploadSpec = {
  uploadId: string;
  itemId: string;
  name: string;
  size: number;
  sha256: string;
};
export type AttachmentUploadState = {
  state: 'uploading' | 'committed';
  received: number;
  total: number;
  chunkBytes: number;
  workspacePath: string;
};
export type AttachmentUploadChunk = AttachmentUploadSpec & { offset: number; data: string; chunkSha256: string };
