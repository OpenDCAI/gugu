// A file edited as a whole: read once, kept in this page's editor, written back when the person saves. For text that cannot
// be a live document (JSON with comments or an array at the top, a file over a document's size). One meaning with the host's
// text models (lib/text-model/model-registry.ts):
//
//   - two texts: the buffer (the editor's) and the file as last read; unsaved = they differ.
//   - the file changed: no unsaved edits, the buffer becomes it; unsaved edits, its change merges in beside them, and the
//     buffer stays unsaved until a save writes the merged text. Not an undo step.
//   - saving: refused as `conflict` (someone else's write since this read), read again, merge, write once more.
//   - gone: the text stays.
//
// Pure, the editor and the file calls handed in: judged in tests/unit/desktop/preinstalledApps/workspaceSourceFile.test.ts.

/** The file's line ending, by majority: lines are kept apart in the document and written back with it. */
function lineEnding(text) {
  const crlf = text.split('\r\n').length - 1
  return crlf > text.split('\n').length - 1 - crlf ? '\r\n' : '\n'
}

const documentText = (text) => text.replace(/\r\n?/g, '\n')

/**
 * @param io `{ read(): { content } | { becameDocument: true }, write(text) }`, one file's calls.
 * @param text `{ mergeThreeWay, diffHunks }`, the platform's.
 * @param onChange told whenever `dirty` or `deleted` may have changed.
 * @param onError a failed save, the error as it came.
 * @param onDocument the file became something that opens live.
 */
export function sourceFile({ io, text, onChange, onError, onDocument }) {
  let disk = ''
  let diskEol = '\n'
  let eol = '\n'
  let editor = null
  let reloading = false
  let refreshing = null
  let refreshAgain = false
  const self = { dirty: false, deleted: false }

  const value = () => editor.text().replaceAll('\n', eol)
  const diskValue = () => disk.replaceAll('\n', diskEol)
  const report = (next) => {
    Object.assign(self, next)
    onChange()
  }
  const setDisk = (content) => {
    disk = documentText(content)
    diskEol = lineEnding(content)
  }
  const replaceBuffer = (next) => {
    const mine = editor.text()
    if (next === mine) return
    reloading = true
    editor.apply(text.diffHunks(mine, next))
    reloading = false
  }

  /** The file says `content` now. */
  function applyDisk(content) {
    const base = disk
    setDisk(content)
    const mine = editor.text()
    const next = !self.dirty || mine === disk ? disk : text.mergeThreeWay(base, mine, disk)
    replaceBuffer(next)
    report({ dirty: next !== disk })
  }

  // One read at a time, and one more if the file changed meanwhile: a write shows as two changes (emptied, then filled), and
  // a read of the empty one finishing last must not be what the buffer takes. As the host's text models do (`readDiskInTurn`).
  function refresh() {
    if (refreshing) {
      refreshAgain = true
      return refreshing
    }
    refreshing = (async () => {
      do {
        refreshAgain = false
        await readDisk()
      } while (refreshAgain)
      refreshing = null
    })()
    return refreshing
  }

  async function readDisk(seenEmpty = false) {
    let read
    try {
      read = await io.read()
    } catch (error) {
      // Unreachable is not gone: only the file's own not-found says deleted.
      if (error?.code === 'not-found') report({ deleted: true })
      return
    }
    report({ deleted: false })
    if (read.becameDocument) onDocument()
    // Empty where it was not: most likely caught mid-write, so not taken on one read. Empty twice, it is empty.
    else if (read.content === '' && disk !== '' && !seenEmpty) return readDisk(true)
    else applyDisk(read.content)
  }

  return Object.assign(self, {
    /** What was read when the file opened. */
    load(content) {
      setDisk(content)
      eol = diskEol
    },

    /** The editor is up, showing the file: `{ text(): its document, apply(hunks): replaced there, outside its history }`. */
    attach(view) {
      editor = view
    },

    /** The person typed. */
    edited() {
      if (!reloading) report({ dirty: value() !== diskValue() })
    },

    /** Something changed the file where it is. */
    refresh,

    /** True once written. False: not saved (`onError` was told), the edits are all still here. */
    async save(merged = false) {
      if (!self.dirty) return true
      const content = value()
      try {
        await io.write(content)
      } catch (error) {
        if (error?.code === 'conflict' && !merged) {
          await refresh()
          // Their change may be all there was left to write.
          return self.save(true)
        }
        onError(error)
        return false
      }
      setDisk(content)
      // What was typed while it was being written is still unsaved.
      report({ deleted: false, dirty: value() !== content })
      await refresh()
      return true
    },

    /** The person chose not to keep the edits. */
    discard() {
      replaceBuffer(disk)
      report({ dirty: false })
    },
  })
}

/**
 * Places in the text that stay on their words as it changes, in the shape the Markdown page keeps them (`file.anchor`,
 * `file.resolve`): the live document's come from its CRDT, these from the editor's changes.
 */
export function bufferAnchors() {
  const live = new Set()
  return {
    anchor(at, assoc = 1) {
      const place = { at, assoc }
      live.add(place)
      return place
    },
    resolve: (place) => (live.has(place) ? place.at : null),
    moved(changes) {
      for (const place of live) place.at = changes.mapPos(place.at, place.assoc)
    },
  }
}

/** The start of `text` within `bytes` of UTF-8, up to the end of a line where there is one. */
export function firstBytes(text, bytes) {
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(bytes))
  if (read === text.length) return text
  const end = text.lastIndexOf('\n', read)
  return text.slice(0, end > 0 ? end : read)
}
