import { getFileKind } from '@renderer/lib/editor/fileKind';

/** The tab a session's file opens in when no App claims it: text is edited, anything else is read in the file preview. */
export function hostViewerKind(path: string): 'file' | 'file-view' {
  const kind = getFileKind(path);
  return kind === 'text' || kind === 'markdown' || kind === 'csv' || kind === 'html' || kind === 'svg' ? 'file' : 'file-view';
}
