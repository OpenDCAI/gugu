import type { FileChangeUpdate, FileNode, NodeId } from '@gugu/session-core/files';
import { defineEvent } from '@shared/lib/ipc/events';

export type FileChangesEvent = {
  projectId: string;
  workspaceId: string;
  update: FileChangeUpdate;
};

export const fileChangesChannel = defineEvent<FileChangesEvent>('files:changes');

/** A whole, current listing of a single directory scope (children of `scopeId`; root is `null`). */
export type FileTreeProjectionScope = {
  scopeId: NodeId | null;
  entries: FileNode[];
};

