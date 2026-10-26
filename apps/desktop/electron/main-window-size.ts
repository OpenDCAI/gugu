type Size = { width: number; height: number }

const DEFAULT_WINDOW_TARGET = { width: 1280, height: 900 } as const
const WINDOW_MIN = { width: 800, height: 600 } as const

/** Keep the normal desktop floor only while the display's usable area can contain it. */
export function mainWindowSize(workArea: Size, preferred: Size = DEFAULT_WINDOW_TARGET) {
  const minWidth = Math.min(WINDOW_MIN.width, workArea.width)
  const minHeight = Math.min(WINDOW_MIN.height, workArea.height)
  return {
    width: Math.min(workArea.width, Math.max(minWidth, preferred.width)),
    height: Math.min(workArea.height, Math.max(minHeight, preferred.height)),
    minWidth,
    minHeight,
  }
}
