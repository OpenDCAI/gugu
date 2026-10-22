import type { ChatDiff, ChatItem, FileChangeSummaryItem } from '@session-chat/model'
import { countChanges, type DiffRow } from '@session-chat/components/rows/tools/diff/diff-lines'

/** Only acknowledged edits count. Reads, proposed edits, failures and subagent work stay in the process. */
export function successfulFileDiff(item: ChatItem): ChatDiff | null {
  if (
    ('parentToolCallId' in item && item.parentToolCallId) ||
    ('parentId' in item && item.parentId)
  )
    return null
  if (
    !('status' in item) ||
    item.status !== 'done' ||
    ('awaitingPermission' in item && item.awaitingPermission)
  )
    return null
  if (item.kind === 'diff') return item
  if (item.kind === 'create-file-tool-call')
    return {
      kind: 'diff',
      id: item.id,
      path: item.path,
      oldText: null,
      newText: item.content,
      status: 'done'
    }
  if (item.kind === 'modify-file-tool-call')
    return {
      kind: 'diff',
      id: item.id,
      path: item.path,
      oldText: item.oldText,
      newText: item.newText,
      status: 'done'
    }
  return null
}

/** `computeDiff` is the chat's cached diff (`ChatCaches.computeDiff`): every reseed of the page asks again for the same diffs. */
export function fileChangeSummary(
  turns: readonly { items: readonly ChatItem[] }[],
  turnId: string,
  computeDiff: (oldText: string | null, newText: string) => DiffRow[]
): FileChangeSummaryItem | null {
  const byPath = new Map<string, ChatDiff[]>()
  for (const turn of turns) {
    for (const item of turn.items) {
      const diff = successfulFileDiff(item)
      if (!diff) continue
      const diffs = byPath.get(diff.path) ?? []
      const previous = diffs.at(-1)
      // Only a newly created file supplies a full-file baseline. Independent replaced regions
      // retain their own before/after bytes; never pretend a region is the complete file.
      if (previous?.oldText === null && previous.newText === diff.oldText)
        diffs[diffs.length - 1] = { ...diff, oldText: previous.oldText }
      else diffs.push(diff)
      byPath.set(diff.path, diffs)
    }
  }
  const files = [...byPath].map(([path, diffs]) => {
    const stats = diffs.reduce(
      (sum, diff) => {
        const next = countChanges(computeDiff(diff.oldText, diff.newText))
        return { adds: sum.adds + next.adds, dels: sum.dels + next.dels }
      },
      { adds: 0, dels: 0 }
    )
    return { path, diffs, ...stats }
  })
  return files.length
    ? { kind: 'file-change-summary', id: `${turnId}:file-changes`, turnId, files }
    : null
}
