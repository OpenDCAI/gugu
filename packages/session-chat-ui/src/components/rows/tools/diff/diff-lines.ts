import type { SessionPatch } from '@gugu/session-core/acp';

export type DiffRowType = 'context' | 'add' | 'remove' | 'hunk' | 'meta';
export type DiffRow = { type: DiffRowType; text: string; oldIdx?: number; newIdx?: number };

/** Read patch rows without joining separated hunks or manufacturing file contents. */
export function parsePatchRows(patch: SessionPatch): DiffRow[] {
  if (!patch.patch) return [];
  const lines = patch.patch.text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (patch.patch.format !== 'git_patch') return lines.map(text => ({ type: 'meta', text }));
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  return lines.map(text => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]) - 1; newLine = Number(hunk[3]) - 1;
      oldLeft = Number(hunk[2] ?? 1); newLeft = Number(hunk[4] ?? 1);
      return { type: 'hunk', text: patch.scope === 'fragment' ? `… ${text}` : text };
    }
    if (text.startsWith('\\')) return { type: 'meta', text };
    if (oldLeft > 0 && text.startsWith('-')) { oldLeft--; return { type: 'remove', text: text.slice(1), oldIdx: oldLine++ }; }
    if (newLeft > 0 && text.startsWith('+')) { newLeft--; return { type: 'add', text: text.slice(1), newIdx: newLine++ }; }
    if (oldLeft > 0 && newLeft > 0 && text.startsWith(' ')) {
      oldLeft--; newLeft--; return { type: 'context', text: text.slice(1), oldIdx: oldLine++, newIdx: newLine++ };
    }
    return { type: 'meta', text };
  });
}

export function countChanges(rows: readonly DiffRow[]): { adds: number; dels: number } {
  return { adds: rows.filter(row => row.type === 'add').length, dels: rows.filter(row => row.type === 'remove').length };
}

/** Binary, omitted and opaque patches do not claim textual counts. */
export function patchStats(patch: SessionPatch): { adds: number; dels: number } | null {
  if (!patch.patch || patch.patch.format !== 'git_patch' || patch.changes.some(change => 'fileType' in change && change.fileType === 'binary') || /(?:^|\n)(?:GIT binary patch|Binary files )/.test(patch.patch.text)) return null;
  return countChanges(parsePatchRows(patch));
}

/** Keep the hunk marker in view; omitted rows are explicitly signalled by the caller. */
export function selectPreview(rows: DiffRow[], maxLines = 12, _context = 1): DiffRow[] {
  const hunk = rows.findIndex(row => row.type === 'hunk');
  return rows.slice(hunk >= 0 ? hunk : 0, (hunk >= 0 ? hunk : 0) + maxLines);
}
