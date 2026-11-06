// A working copy's writes live in the folder App (`gugu.files`). What stays here is a file's download from another machine,
// for the file preview's menu; on this computer the file is already here, so the backend offers none.
export type WorkspaceTreeScope = {
  projectId: string;
  workspaceId: string;
};

export type WorkspaceTreeEntry = {
  path: string;
  name: string;
  kind: 'file' | 'directory' | 'symlink';
  size?: number;
};

export interface WorkspaceTreeBackend {
  download?(scope: WorkspaceTreeScope, entry: WorkspaceTreeEntry): Promise<void>;
}
