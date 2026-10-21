import type { Result } from '@gugu/session-shared';

export type FileWatchEventType = 'create' | 'delete' | 'modify' | 'rename';

export interface FileWatchEvent {
  type: FileWatchEventType;
  entryType: 'file' | 'directory' | 'symlink';
  path: string;
  oldPath?: string;
}

export type BrowseLocalDirectoryParams = {
  type: 'local';
  path: string;
};

export type BrowseDirectoryParams = BrowseLocalDirectoryParams;

export type DirectoryEntry = {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedAt: Date;
};

export type BrowseDirectoryError =
  | { type: 'invalid-path'; path: string; message: string }
  | { type: 'filesystem-error'; path: string; message: string };

export type BrowseDirectoryResult = Result<DirectoryEntry[], BrowseDirectoryError>;
