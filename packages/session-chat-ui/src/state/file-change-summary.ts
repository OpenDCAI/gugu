import type { SessionPatch } from '@gugu/session-core/acp'
import { changedFilePaths, projectToolContent } from '@gugu/session-core/acp'
import type { ChatDiff, ChatItem, FileChangeSummaryItem } from '@session-chat/model'
import { patchStats } from '@session-chat/components/rows/tools/diff/diff-lines'

/** Only acknowledged edits count. The patch bytes are a view of canonical content. */
export function successfulFileDiff(item: ChatItem): ChatDiff | null {
  if (('parentToolCallId' in item && item.parentToolCallId) || ('parentId' in item && item.parentId)) return null
  if (!('status' in item) || item.status !== 'done' || ('awaitingPermission' in item && item.awaitingPermission)) return null
  if (item.kind === 'diff') return item
  return item.kind === 'patch-tool-call' ? { kind: 'diff', id: item.id, patches: projectToolContent(item.contentBlocks ?? []).diffs, status: 'done' } : null
}

function total(patches: readonly SessionPatch[]): { adds: number | null; dels: number | null } {
  let adds = 0; let dels = 0
  for (const patch of patches) {
    const stats = patchStats(patch)
    if (!stats) return { adds: null, dels: null }
    adds += stats.adds; dels += stats.dels
  }
  return { adds, dels }
}

/** Counts are the observed patch operations, never a guessed task-wide file baseline. */
export function fileChangeSummary(turns: readonly { items: readonly ChatItem[] }[], turnId: string): FileChangeSummaryItem | null {
  const byPath = new Map<string, ChatDiff[]>()
  const patches: SessionPatch[] = []
  for (const turn of turns) for (const item of turn.items) {
    const diff = successfulFileDiff(item)
    if (!diff) continue
    patches.push(...diff.patches)
    for (const path of changedFilePaths(diff.patches)) {
      const files = byPath.get(path) ?? []
      files.push(diff); byPath.set(path, files)
    }
  }
  const files = [...byPath].map(([path, diffs]) => {
    const relevant = diffs.flatMap(diff => diff.patches.filter(patch => changedFilePaths([patch]).includes(path)))
    // A multi-file patch does not locate its textual totals per structured path.
    const stats = relevant.some(patch => patch.changes.length !== 1) ? { adds: null, dels: null } : total(relevant)
    return { path, diffs, ...stats }
  })
  return files.length ? { kind: 'file-change-summary', id: `${turnId}:file-changes`, turnId, files, ...total(patches) } : null
}
