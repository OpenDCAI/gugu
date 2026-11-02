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

/** Task content search: the query and how many of the newest hits to return (the search panel counts them). */
export interface TaskTurnQuery {
  query: string;
  limit?: number;
}

/** Where each whitespace-separated piece of the query occurs in text (case-insensitive), merged, for highlighting. */
export function matchRanges(text: string, query: string): { start: number; end: number }[] {
  const lower = text.toLowerCase();
  const ranges: { start: number; end: number }[] = [];
  for (const piece of query.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    for (let at = lower.indexOf(piece); at !== -1; at = lower.indexOf(piece, at + piece.length)) ranges.push({ start: at, end: at + piece.length });
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
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
