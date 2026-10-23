// Native Codex file facts enter ACP once. Patch bytes are never expanded into file contents.
import { textFilePatch } from '../../../../packages/session-core/src/lib/text-diff.ts'

export function codexFilePatches(item) {
  return (item?.changes ?? []).map(change => {
    const { path, kind, diff } = change
    if (kind.type === 'add') return textFilePatch(path, null, diff)
    if (kind.type === 'delete') return textFilePatch(path, diff, null)
    if (kind.type !== 'update') throw new Error(`Unsupported Codex file change: ${kind.type}`)
    const destination = kind.move_path ?? path
    const changes = [kind.move_path
      ? { operation: 'move', oldPath: path, path: destination }
      : { operation: 'modify', path }]
    // Codex updates carry hunks. Add file headers without touching any supplied byte.
    const headers = `diff --git ${JSON.stringify('a/' + path)} ${JSON.stringify('b/' + destination)}\n`
      + (kind.move_path ? `rename from ${path}\nrename to ${destination}\n` : '')
      + `--- ${JSON.stringify('a/' + path)}\n+++ ${JSON.stringify('b/' + destination)}\n`
    return { type: 'diff', changes, scope: 'file', patch: { format: 'git_patch',
      text: diff.startsWith('diff --git ') ? diff : headers + diff } }
  })
}
