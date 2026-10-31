export type SearchItemKind = 'project' | 'session';

export interface SearchItem {
  kind: SearchItemKind;
  id: string;
  projectId: string | null;
  title: string;
  subtitle: string;
  score: number;
}

/** A message said in a local task, as task search finds it (turn_text). */
export interface TaskTurnHit {
  sessionId: string;
  projectId: string;
  title: string;
  archived: boolean;
  itemId: string;
  role: 'user' | 'assistant';
  excerpt: string;
  at: string;
}

/** The visible part of a matched text around the query's first piece, for a result row. */
export function excerpt(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const first = query.trim().split(/\s+/)[0] ?? '';
  const at = Math.max(0, flat.toLowerCase().indexOf(first.toLowerCase()));
  const start = Math.max(0, at - 30);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + 120)}${start + 120 < flat.length ? '…' : ''}`;
}

export interface CommandPaletteQuery {
  query: string;
}

export interface WorkspaceFileSearchQuery {
  workspaceId: string;
  query: string;
  limit?: number;
}

export interface WorkspaceFileHit {
  path: string;
  filename: string;
}
