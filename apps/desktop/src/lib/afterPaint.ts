/**
 * @@@after-paint - Geometry that scrolling changes (at the bottom? which row is on top?) is read after the frame is painted.
 * Inside a scroll handler the layout is often dirty (rows sliding under the pointer change :hover, avatars animate), so every
 * read there forces a style + layout pass on every frame. After the paint the layout is clean and the same reads are free.
 * All reads scheduled for a frame run together in one task, in scheduling order: every reader sees the same painted frame
 * before anything reacts to one of them (the list withdrawing tail following must not outrun the scroll memory's capture).
 */
const pending = new Set<() => void>()
let scheduled = false

function flush(): void {
  scheduled = false
  const reads = [...pending]
  pending.clear()
  for (const read of reads) read()
}

export function afterPaint(read: () => void): { schedule: () => void; cancel: () => void } {
  return {
    schedule: () => {
      pending.add(read)
      if (scheduled) return
      scheduled = true
      // rAF runs before this frame's style/layout/paint; a task queued from it runs after the paint.
      requestAnimationFrame(() => { setTimeout(flush) })
    },
    cancel: () => { pending.delete(read) },
  }
}
