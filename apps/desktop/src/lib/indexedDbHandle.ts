/** Own a reusable handle, including the browser's unexpected-close lifecycle. */
export function createIndexedDbHandle(open: () => Promise<IDBDatabase>) {
  let current: IDBDatabase | null = null
  let opening: Promise<IDBDatabase> | null = null
  let disposed = false
  const disposedError = new Error('IndexedDB handle was closed by its owner')

  return {
    get(): Promise<IDBDatabase> {
      if (disposed) return Promise.reject(disposedError)
      if (current) return Promise.resolve(current)
      if (!opening) {
        const attempt = open().then(db => {
          if (disposed) { db.close(); throw disposedError }
          current = db
          // A forced close (e.g. browser storage I/O failure) does not make a saved
          // IDBDatabase usable again. Only the next operation opens a new handle;
          // the interrupted operation keeps its original failure and is not replayed.
          db.addEventListener('close', () => { if (current === db) current = null }, { once: true })
          return db
        })
        opening = attempt
        const settled = () => { if (opening === attempt) opening = null }
        void attempt.then(settled, settled)
      }
      return opening
    },
    close() {
      disposed = true
      current?.close()
      current = null
    },
  }
}

export type IndexedDbHandle = ReturnType<typeof createIndexedDbHandle>
