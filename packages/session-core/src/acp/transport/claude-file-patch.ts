import type { ClaudeFileChange } from '@gugu/core/local/agent/transcriptSources/claudeCode';
import type { SessionPatch } from '../session-protocol';
import { textFilePatch } from '../../lib/text-diff';

/** Native hunk coordinates and lines are authoritative, including CR and EOF marker bytes. */
export function claudeFilePatch(change: ClaudeFileChange): SessionPatch & { type: 'diff' } {
  if ('after' in change) return textFilePatch(change.path, change.before, change.after, 'file');
  const a = JSON.stringify('a/' + change.path);
  const b = JSON.stringify('b/' + change.path);
  const text = `diff --git ${a} ${b}\n--- ${a}\n+++ ${b}\n`
    + change.hunks.map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`).join('');
  return { type: 'diff', changes: [{ operation: 'modify', path: change.path }], scope: 'file', patch: { format: 'git_patch', text } };
}
